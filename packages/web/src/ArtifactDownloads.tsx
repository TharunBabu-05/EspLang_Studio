import type { Firmware } from '@esplang/compiler';
export function ArtifactDownloads({ firmware }: { firmware: Firmware }) {
  function save(name: string, data: BlobPart): void {
    const url = URL.createObjectURL(new Blob([data]));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="artifact-downloads" aria-label="Firmware downloads">
      <span className="eyebrow">BUILD IMAGES</span>
      {firmware.artifacts.map((artifact) => (
        <button
          key={artifact.name}
          onClick={() =>
            save(
              artifact.name,
              Uint8Array.from(atob(artifact.data), (c) => c.charCodeAt(0)),
            )
          }
          title={`Download ${artifact.name} (${artifact.size} bytes)`}
        >
          ↓ {artifact.name}
          <small>0x{artifact.address.toString(16)}</small>
        </button>
      ))}
      <button onClick={() => save('firmware.json', JSON.stringify(firmware, null, 2))}>
        ↓ Manifest
      </button>
    </div>
  );
}
