/** Initial-letter avatar with a hue derived from the user id, so each person keeps the same colour. */
export function Avatar({ id, name, online }: { id: string; name: string; online?: boolean }) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ "--hue": hash % 360 } as React.CSSProperties} aria-hidden>
      {name[0]?.toUpperCase() ?? "?"}
      {online !== undefined && <span className={`dot ${online ? "on" : ""}`} />}
    </span>
  );
}
