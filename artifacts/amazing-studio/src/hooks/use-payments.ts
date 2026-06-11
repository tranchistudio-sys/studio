import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  listPayments, getListPaymentsQueryKey,
  createPayment
} from "@workspace/api-client-react";
import type { CreatePaymentRequest } from "@workspace/api-client-react/src/generated/api.schemas";

export function usePayments(bookingId?: number, rentalId?: number) {
  return useQuery({
    queryKey: getListPaymentsQueryKey({ bookingId, rentalId }),
    queryFn: () => listPayments({ bookingId, rentalId }),
  });
}

export function useCreatePaymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePaymentRequest) => createPayment(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rentals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}
