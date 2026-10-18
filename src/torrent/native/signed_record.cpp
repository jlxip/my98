// Exact signed-record publication; no Python callback runs on libtorrent's thread.
#include <boost/python.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/bdecode.hpp>
#include <libtorrent/bencode.hpp>
#include <libtorrent/entry.hpp>
#include <algorithm>
#include <iterator>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>

namespace bp = boost::python;
namespace lt = libtorrent;
namespace {
std::string bytes(bp::object const& object) {
    if (!PyBytes_Check(object.ptr())) throw std::invalid_argument("Expected bytes");
    char* data = nullptr; Py_ssize_t length = 0;
    if (PyBytes_AsStringAndSize(object.ptr(), &data, &length) < 0) bp::throw_error_already_set();
    return {data, static_cast<std::size_t>(length)};
}
std::string encode(lt::entry const& value) {
    std::string result; lt::bencode(std::back_inserter(result), value); return result;
}
struct PutResult {
    std::atomic<bool> invoked{false};
    std::atomic<bool> conflict{false};
    std::atomic<std::int64_t> observed_sequence{0};
    bool was_invoked() const {return invoked.load(std::memory_order_acquire);}
    bool has_conflict() const {return conflict.load(std::memory_order_acquire);}
    std::int64_t sequence() const {return observed_sequence.load(std::memory_order_acquire);}
};
std::shared_ptr<PutResult> put_signed(bp::object const& session, bp::object const& key_arg,
    bp::object const& salt_arg, bp::object const& value_arg, std::int64_t sequence,
    bp::object const& signature_arg) {
    // Import the official module before extracting its registered session type.
    bp::import("libtorrent");
    auto& native = bp::extract<lt::session&>(session)();
    auto key = bytes(key_arg), salt = bytes(salt_arg), encoded = bytes(value_arg), signature = bytes(signature_arg);
    if (key.size() != 32 || signature.size() != 64 || salt.size() > 64 ||
        encoded.empty() || encoded.size() > 1000 || sequence < 1 || sequence > 9007199254740991LL)
        throw std::invalid_argument("Invalid signed mutable record");
    lt::bdecode_node node; lt::error_code error;
    if (lt::bdecode(encoded.data(), encoded.data() + encoded.size(), node, error, nullptr, 8, 128) < 0)
        throw std::invalid_argument("Invalid bencoded value");
    lt::entry candidate(node);
    if (encode(candidate) != encoded) throw std::invalid_argument("Noncanonical bencoded value");
    std::array<char, 32> public_key; std::copy(key.begin(), key.end(), public_key.begin());
    std::array<char, 64> sig; std::copy(signature.begin(), signature.end(), sig.begin());
    auto result = std::make_shared<PutResult>();
    native.dht_put_item(public_key,
        [candidate, encoded, sig, sequence, result](lt::entry& value, std::array<char, 64>& current_sig,
            std::int64_t& current_sequence, std::string const&) {
            result->observed_sequence.store(current_sequence, std::memory_order_relaxed);
            if (current_sequence > sequence || (current_sequence == sequence && encode(value) != encoded)) {
                // Preserve the newer/conflicting record. The caller must report conflict,
                // regardless of how many peers accepted this unrelated existing value.
                result->conflict.store(true, std::memory_order_release);
            } else {
                value = candidate; current_sig = sig; current_sequence = sequence;
            }
            result->invoked.store(true, std::memory_order_release);
        }, salt);
    return result;
}
}
BOOST_PYTHON_MODULE(my98_libtorrent) {
    bp::import("libtorrent");
    bp::class_<PutResult, std::shared_ptr<PutResult>, boost::noncopyable>("PutResult", bp::no_init)
        .add_property("invoked", &PutResult::was_invoked)
        .add_property("conflict", &PutResult::has_conflict)
        .add_property("observed_sequence", &PutResult::sequence);
    bp::def("put_signed", put_signed);
}
