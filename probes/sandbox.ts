import path from 'node:path';

/** Prepare a disconnected inspection VM; this does not launch or qualify Desktop. */
export function sandboxConfiguration(installation: string): string {
  if (!/^[A-Za-z]:\\[^<>:"|?*\x00-\x1f]+$/.test(installation)
    || installation.includes('/')
    || installation.slice(3).split('\\').some(part => !part || /[. ]$/.test(part))) {
    throw new Error('Supply an absolute local installation directory, not a drive root or share');
  }
  // Windows normalizes path segments by stripping trailing dots and spaces.
  // Reject any path whose Win32 normalization resolves back to a drive root or traverses parents.
  const win32Normalized = path.win32.normalize(
    installation.slice(0, 3) + installation.slice(3).split('\\').map(part => part.replace(/[. ]+$/, '')).join('\\')
  );
  if (/^[A-Za-z]:\\?$/.test(win32Normalized) || win32Normalized.includes('..')) {
    throw new Error('Supply an absolute local installation directory, not a drive root or share');
  }
  const escaped = installation.replaceAll('&', '&amp;');
  return `<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${escaped}</HostFolder>
      <SandboxFolder>C:\\ArloInstallation</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
</Configuration>
`;
}
