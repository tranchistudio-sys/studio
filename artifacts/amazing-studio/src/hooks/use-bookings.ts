import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  listBookings, getListBookingsQueryKey,
  getBooking, getGetBookingQueryKey,
  createBooking, updateBooking, deleteBooking
} from "@workspace/api-client-react";
import type { CreateBookingRequest, UpdateBookingRequest } from "@workspace/api-client-react/src/generated/api.schemas";

export function useBookings(status?: string, customerId?: number) {
  return useQuery({
    queryKey: getListBookingsQueryKey({ status, customerId }),
    queryFn: () => listBookings({ status, customerId }),
  });
}

export function useBooking(id: number) {
  return useQuery({
    queryKey: getGetBookingQueryKey(id),
    queryFn: () => getBooking(id),
    enabled: !!id,
  });
}

export function useCreateBookingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateBookingRequest) => createBooking(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}

export function useUpdateBookingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateBookingRequest }) => updateBooking(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      queryClient.invalidateQueries({ queryKey: getGetBookingQueryKey(variables.id) });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}

export function useDeleteBookingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteBooking(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}
