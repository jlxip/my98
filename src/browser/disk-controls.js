/** Availability of disk actions, independent of the DOM. */
export function diskControls({busy, working, client, state, active, adapter, analyzing, prepared, capturing, stateAbort}) {
    const locked = busy || working;
    const open = !!state;
    const remote = !!state?.remote;
    const publishedState = !!state?.remote?.stateCid;
    const failed = !!adapter?.failed;
    const stateInProgress = !!stateAbort;
    return {
        authenticated: !!client,
        hideEmptyForm: !client || open,
        analyzing,
        showRetry: failed,
        showCancel: capturing || stateInProgress,
        showStateCancel: stateInProgress,
        disabled: {
            empty: locked || open,
            'empty-size': locked || open,
            'empty-submit': locked || open,
            'empty-cancel': locked || open,
            create: locked || open,
            open: locked || open,
            remote: locked || open,
            'only-localhost': locked || open,
            boot: locked || !open || active || failed,
            save: locked || !open || !active || failed || analyzing,
            download: locked || !open || !!state?.dirty_bytes || analyzing,
            discard: locked || !open || analyzing,
            verify: locked || !open || analyzing,
            'resume-state': locked || !publishedState || active || analyzing || failed,
            analyze: locked || (!analyzing && (!remote || failed)),
            'analyze-boot': locked || !remote || !!state?.dirty_bytes || analyzing,
            'analyze-resume': locked || !publishedState || analyzing,
            'analyze-file': locked || !remote || analyzing,
            retry: locked || !prepared || analyzing,
            resume: locked || !failed,
            'load-state': locked || !open || analyzing,
            'save-state': locked || !active || analyzing || failed,
            'cancel-state': false,
            cancel: !capturing && !stateInProgress,
        },
    };
}
