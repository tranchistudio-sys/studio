import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  listCustomers, getListCustomersQueryKey,
  getCustomer, getGetCustomerQueryKey,
  createCustomer, updateCustomer, deleteCustomer
} from "@workspace/api-client-react";
import type { CreateCustomerRequest } from "@workspace/api-client-react/src/generated/api.schemas";

export function useCustomers(search?: string) {
  return useQuery({
    queryKey: getListCustomersQueryKey({ search }),
    queryFn: () => listCustomers({ search }),
  });
}

export function useCustomer(id: number) {
  return useQuery({
    queryKey: getGetCustomerQueryKey(id),
    queryFn: () => getCustomer(id),
    enabled: !!id,
  });
}

export function useCreateCustomerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCustomerRequest) => createCustomer(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
    },
  });
}

export function useUpdateCustomerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: CreateCustomerRequest }) => updateCustomer(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(variables.id) });
    },
  });
}

export function useDeleteCustomerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteCustomer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
    },
  });
}
