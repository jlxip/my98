/* A stack and its callbacks are confined to one Rust-owned thread. */
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <libslirp.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <ifaddrs.h>

#define MAX_FDS 4096
typedef slirp_ssize_t (*Send)(const void *, size_t, void *);
typedef struct Timer {
    struct Timer *next;
    SlirpTimerCb cb;
    void *arg;
    int64_t expires;
} Timer;
typedef struct Bridge {
    Slirp *slirp;
    SlirpCb callbacks;
    Send send;
    void *opaque;
    struct pollfd fds[MAX_FDS];
    int count;
    Timer *timers;
} Bridge;
static int64_t clock_ns(void *opaque) {
    (void)opaque;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}
static slirp_ssize_t send_packet(const void *buf, size_t n, void *opaque) {
    Bridge *b = opaque;
    return b->send(buf, n, b->opaque);
}
/* libslirp guest errors may include destinations or content: never log them. */
static void guest_error(const char *msg, void *opaque) { (void)msg; (void)opaque; }
static void noop_fd(int fd, void *opaque) { (void)fd; (void)opaque; }
static void notify(void *opaque) { (void)opaque; }
static void *timer_new(SlirpTimerCb cb, void *arg, void *opaque) {
    Bridge *b = opaque;
    Timer *t = calloc(1, sizeof(*t));
    if (!t) abort();
    t->cb = cb; t->arg = arg; t->expires = -1;
    t->next = b->timers; b->timers = t;
    return t;
}
static void timer_free(void *timer, void *opaque) {
    Bridge *b = opaque;
    Timer **p = &b->timers;
    while (*p && *p != timer) p = &(*p)->next;
    if (*p) { Timer *t = *p; *p = t->next; free(t); }
}
static void timer_mod(void *timer, int64_t expiry, void *opaque) {
    (void)opaque; ((Timer *)timer)->expires = expiry;
}
static int add_poll(int fd, int flags, void *opaque) {
    Bridge *b = opaque;
    if (b->count == MAX_FDS) return -1;
    int i = b->count++;
    short events = 0;
    if (flags & SLIRP_POLL_IN) events |= POLLIN;
    if (flags & SLIRP_POLL_OUT) events |= POLLOUT;
    if (flags & SLIRP_POLL_PRI) events |= POLLPRI;
    b->fds[i] = (struct pollfd){fd, events, 0};
    return i;
}
static int revents(int i, void *opaque) {
    Bridge *b = opaque;
    if (i < 0 || i >= b->count) return 0;
    short v = b->fds[i].revents;
    int flags = 0;
    if (v & POLLIN) flags |= SLIRP_POLL_IN;
    if (v & POLLOUT) flags |= SLIRP_POLL_OUT;
    if (v & POLLPRI) flags |= SLIRP_POLL_PRI;
    if (v & (POLLERR | POLLNVAL)) flags |= SLIRP_POLL_ERR;
    if (v & POLLHUP) flags |= SLIRP_POLL_HUP;
    return flags;
}
Bridge *my98_slirp_new(Send send, void *opaque) {
    Bridge *b = calloc(1, sizeof(*b));
    if (!b) return NULL;
    b->send = send; b->opaque = opaque;
    SlirpConfig c = {0};
    c.version = 4; c.in_enabled = true; c.in6_enabled = false;
    inet_pton(AF_INET, "10.5.0.0", &c.vnetwork);
    inet_pton(AF_INET, "255.255.0.0", &c.vnetmask);
    inet_pton(AF_INET, "10.5.0.1", &c.vhost);
    inet_pton(AF_INET, "10.5.0.1", &c.vnameserver);
    inet_pton(AF_INET, "10.5.0.100", &c.vdhcp_start);
    c.if_mtu = c.if_mru = 1500;
    c.disable_host_loopback = true;
    c.enable_emu = false;
    /* NULL TFTP paths, no helpers, no host/guest forwarding. */
    SlirpCb *cb = &b->callbacks; /* libslirp retains this pointer. */
    cb->send_packet = send_packet; cb->guest_error = guest_error;
    cb->clock_get_ns = clock_ns; cb->timer_new = timer_new;
    cb->timer_free = timer_free; cb->timer_mod = timer_mod;
    cb->register_poll_fd = noop_fd; cb->unregister_poll_fd = noop_fd;
    cb->notify = notify;
    b->slirp = slirp_new(&c, cb, b);
    if (!b->slirp) { free(b); return NULL; }
    return b;
}
void my98_slirp_input(Bridge *b, const unsigned char *data, int n) {
    /* Also block host interfaces, including its public address. */
    if (n >= 34 && data[12] == 8 && data[13] == 0) {
        struct ifaddrs *interfaces = NULL;
        if (getifaddrs(&interfaces) != 0) return; /* fail closed */
        int host = 0;
        for (struct ifaddrs *p = interfaces; p; p = p->ifa_next) {
            if (p->ifa_addr && p->ifa_addr->sa_family == AF_INET &&
                memcmp(data + 30, &((struct sockaddr_in *)p->ifa_addr)->sin_addr, 4) == 0) { host = 1; break; }
        }
        freeifaddrs(interfaces);
        if (host) return;
    }
    slirp_input(b->slirp, data, n);
}
void my98_slirp_poll(Bridge *b) {
    uint32_t timeout = 10; /* Bounded delay also services guest input/shutdown. */
    b->count = 0;
    slirp_pollfds_fill(b->slirp, &timeout, add_poll, b);
    int64_t now = clock_ns(b) / 1000000;
    for (Timer *t = b->timers; t; t = t->next) {
        if (t->expires >= 0) {
            int64_t delay = t->expires - now;
            if (delay < (int64_t)timeout) timeout = delay > 0 ? (uint32_t)delay : 0;
        }
    }
    int result = poll(b->fds, b->count, (int)timeout);
    slirp_pollfds_poll(b->slirp, result < 0, revents, b);
    /* A callback may free timers: restart the traversal after firing. */
    for (;;) {
        Timer *due = NULL;
        now = clock_ns(b) / 1000000;
        for (Timer *t = b->timers; t; t = t->next)
            if (t->expires >= 0 && t->expires <= now) { due = t; break; }
        if (!due) break;
        due->expires = -1;
        due->cb(due->arg);
    }
}
void my98_slirp_free(Bridge *b) {
    slirp_cleanup(b->slirp);
    while (b->timers) timer_free(b->timers, b);
    free(b);
}
