export async function readJsonArrayResponse<T>(response: Response): Promise<T[]> {
  if (!response.ok) {
    throw new Error(`Public API request failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Public API returned an invalid collection");
  }

  return payload as T[];
}

export async function fetchJsonArray<T>(url: string): Promise<T[]> {
  return readJsonArrayResponse<T>(await fetch(url));
}
