import { format, parseISO } from "date-fns";
import { vi } from "date-fns/locale";

export function formatVND(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    return format(parseISO(dateString), "dd/MM/yyyy", { locale: vi });
  } catch (e) {
    return dateString;
  }
}

export function formatDateTime(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    return format(parseISO(dateString), "dd/MM/yyyy HH:mm", { locale: vi });
  } catch (e) {
    return dateString;
  }
}
