/** Same-origin deployment sources; the Worker selects the identity from login or read key. */
export async function publicationOptions() {
    const options={};
    const response=await fetch(new URL("../../torrent-sources.json",import.meta.url),{
        credentials:"omit",redirect:"error",cache:"no-store"});
    if(response.status===404)return options;
    if(!response.ok)throw Error("Could not load torrent source configuration");
    const text=await response.text();
    if(text.length>16384)throw Error("Torrent source configuration is too large");
    options.sources=JSON.parse(text); // The Worker validates all source URLs.
    return options;
}
