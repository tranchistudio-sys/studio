export type DatedServiceDraft = { shootDate: string };

/**
 * Khi người dùng đổi ngày ở đầu form, chỉ dời các dịch vụ đang bám đúng ngày
 * cũ. Dịch vụ đã có ngày riêng khác không được chạm tới.
 */
export function cascadeContractDateToServices<T extends DatedServiceDraft>(
  drafts: T[],
  previousDate: string,
  nextDate: string,
): T[] {
  if (!nextDate || previousDate === nextDate) return drafts;
  return drafts.map((draft) =>
    !draft.shootDate || draft.shootDate === previousDate
      ? { ...draft, shootDate: nextDate }
      : draft,
  );
}
