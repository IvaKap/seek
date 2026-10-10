/*
 * Seek — a `slsk://` link to a file or folder, the form Nicotine+ copies and
 * opens (userbrowse.py `get_soulseek_url`): backslashes become slashes, then
 * Python's `urllib.parse.quote(username + "/" + path)`, which keeps `/` and
 * escapes everything else that is not a letter, a digit or `_.-~`.
 * `encodeURIComponent` leaves `!'()*` alone where quote does not, so those are
 * escaped by hand — get it wrong and a pasted link names a different file.
 */

const quote = (text: string) => encodeURIComponent(text)
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(/%2F/g, '/');

export function soulseekUrl(username: string, path: string, folder = false): string {
  const slashed = path.replace(/\\/g, '/');
  const url = `slsk://${quote(`${username}/${slashed}`)}`;
  return folder && !url.endsWith('/') ? `${url}/` : url;
}
