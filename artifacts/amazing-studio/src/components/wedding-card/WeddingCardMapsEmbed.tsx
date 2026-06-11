function mapsEmbedUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.hostname.includes("google") && parsed.pathname.includes("/maps")) {
      return `https://www.google.com/maps?q=${encodeURIComponent(u)}&output=embed`;
    }
  } catch {
    return null;
  }
  return `https://www.google.com/maps?q=${encodeURIComponent(u)}&output=embed`;
}

export function WeddingCardMapsEmbed({
  label,
  address,
  mapsUrl,
}: {
  label: string;
  address: string | null;
  mapsUrl: string | null;
}) {
  if (!address && !mapsUrl) return null;
  const embed = mapsUrl ? mapsEmbedUrl(mapsUrl) : address ? mapsEmbedUrl(address) : null;
  const link = mapsUrl || (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null);

  return (
    <div className="space-y-2">
      <p className="text-xs tracking-[0.25em] uppercase opacity-70">{label}</p>
      {address && <p className="text-sm leading-relaxed whitespace-pre-line">{address}</p>}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs underline underline-offset-4 opacity-80 hover:opacity-100"
        >
          Mở Google Maps
        </a>
      )}
      {embed && (
        <div className="mt-3 aspect-video w-full overflow-hidden rounded-lg border border-black/10">
          <iframe
            title={label}
            src={embed}
            className="h-full w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      )}
    </div>
  );
}
