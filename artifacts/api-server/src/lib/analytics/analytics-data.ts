export function sanitizeAttribution(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cleanTouch = (touch: unknown) => {
    if (!touch || typeof touch !== "object" || Array.isArray(touch)) return undefined;
    const source = touch as Record<string, unknown>;
    const allowed = ["capturedAt", "landingPage", "referrer", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm", "fbclid", "gclid"];
    const clean: Record<string, string> = {};
    for (const key of allowed) if (typeof source[key] === "string" && source[key]) clean[key] = String(source[key]).slice(0, 2048);
    return Object.keys(clean).length ? clean : undefined;
  };
  const source = value as Record<string, unknown>;
  const firstTouch = cleanTouch(source.firstTouch);
  const lastTouch = cleanTouch(source.lastTouch);
  return firstTouch || lastTouch ? { firstTouch, lastTouch } : null;
}

export function purchaseCustomData(amount: string | number, paymentId: number, bookingId: number) {
  return { value: Number(amount), currency: "VND", payment_id: String(paymentId), booking_id: String(bookingId) };
}
