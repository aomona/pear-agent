import { QueryClient } from "@tanstack/react-query";

/** Shared QueryClient for outing demo (parallel Gemini mutations, etc.). */
export function createOutingQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Parallel free-text structure calls must not be serialized.
        retry: 0,
      },
    },
  });
}
