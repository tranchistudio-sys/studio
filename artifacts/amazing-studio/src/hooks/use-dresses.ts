import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  listDresses, getListDressesQueryKey,
  getDress, getGetDressQueryKey,
  createDress, updateDress, deleteDress
} from "@workspace/api-client-react";
import type { CreateDressRequest } from "@workspace/api-client-react/src/generated/api.schemas";

export function useDresses(available?: boolean) {
  return useQuery({
    queryKey: getListDressesQueryKey({ available }),
    queryFn: () => listDresses({ available }),
  });
}

export function useDress(id: number) {
  return useQuery({
    queryKey: getGetDressQueryKey(id),
    queryFn: () => getDress(id),
    enabled: !!id,
  });
}

export function useCreateDressMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDressRequest) => createDress(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dresses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}

export function useUpdateDressMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: CreateDressRequest }) => updateDress(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dresses"] });
      queryClient.invalidateQueries({ queryKey: getGetDressQueryKey(variables.id) });
    },
  });
}

export function useDeleteDressMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteDress(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dresses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });
}
