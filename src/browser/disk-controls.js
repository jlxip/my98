/** Availability of disk actions, independent of the DOM. */
export function diskControls({busy, working, client, state, active, adapter, analyzing, prepared, capturing, stateAbort, quiescent=true, seeding=false}) {
    const locked = busy || working;
    const open = !!state;
    const remote = !!state?.remote;
    const readOnly=!!state?.readOnly;
    const publishedState = !!state?.remote?.stateInfoHash;
    const failed = !!adapter?.failed;
    const stateInProgress = !!stateAbort;
    // Availability excludes transient locks so an operation does not erase its controls.
    const unavailable = {
        empty: open,
        'empty-size': open,
        'empty-submit': open,
        'empty-cancel': open,
        create: open,
        open: open,
        'relay-key': readOnly,
        boot: !open || active || failed,
        publish: readOnly || !open || analyzing || seeding,
        'publish-file': readOnly || analyzing || seeding,
        'publish-raw': readOnly || analyzing || seeding,
        'download-raw': !open || analyzing,
        download: !open || analyzing,
        discard: !open || analyzing,
        verify: !open || analyzing,
        'clear-cache': !open || analyzing,
        'resume-state': !publishedState || active || analyzing || failed,
        analyze: (!analyzing && (!remote || failed)),
        'analyze-boot': !remote || !!state?.dirty_bytes || analyzing,
        'analyze-resume': !publishedState || analyzing,
        'analyze-file': !remote || analyzing,
        retry: !prepared || analyzing,
        resume: !failed,
        'load-state': !open || analyzing,
        'save-state': readOnly || !active || analyzing || failed,
        'publish-state': readOnly || !remote || !active || analyzing || failed,
        'publish-state-file': readOnly || !remote || analyzing,
        'remove-state': readOnly || !remote || analyzing,
        profiles: readOnly || !remote || analyzing,
        'cancel-state': false,
        cancel: !capturing && !stateInProgress,
    };
    const disabled=Object.fromEntries(Object.entries(unavailable).map(([id,value])=>[id,locked||value]));
    for(const key of ["publish","publish-file","publish-raw","download","download-raw"])disabled[key] ||= !quiescent;
    disabled.cancel=unavailable.cancel;
    disabled['cancel-state']=false;
    return {
        authenticated: !!client,
        hideEmptyForm: !client || open,
        analyzing,
        showRetry: failed,
        showCancel: capturing || stateInProgress,
        showStateCancel: stateInProgress,
        hidden: unavailable,
        disabled,
    };
}
