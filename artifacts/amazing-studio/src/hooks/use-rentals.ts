import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  listRentals, getListRentalsQueryKey,
  getRental, getGetRentalQueryKey,
  createRental, updateRental
} from "@workspace/api-client-react";
import type { CreateRentalRequest, UpdateRentalRequest } from "@workspace/api-client-react/src/generated/api.schemas";

export function useRentals(status?: string) {
  return useQuery({
    queryKey: getListRentalsQueryKey({ status }),
    queryFn: () => listRentals({ status }),
  });
}

export function useRental(id: number) {
  return useQuery({
    queryKey: getGetRentalQueryKey(id),
    queryFn: () => getRental(id),
    enabled: !!id,
  });
}

export function useCreateRentalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateRentalRequest) => createRental(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rentals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dresses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}

export function useUpdateRentalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateRentalRequest }) => updateRental(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rentals"] });
      queryClient.invalidateQueries({ queryKey: getGetRentalQueryKey(variables.id) });
      queryClient.invalidateQueries({ queryKey: ["/api/dresses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}
