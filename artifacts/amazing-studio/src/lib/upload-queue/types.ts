export type UploadJobStatus = "pending" | "uploading" | "uploaded" | "failed";

/** Opaque browser scope. It contains ids only, never a token or email. */
export type UploadQueueScope = {
  key: string;
  tenantId: string;
  membershipId: string;
  userId: string;
};

/** Entity attach — dressId optional until form saved (save-first flow). */
export type UploadAttachTarget = {
  entity: "dress";
  mode: "album" | "cover";
  dressId?: number;
};

export type UploadJob = {
  id: string;
  scope: UploadQueueScope;
  status: UploadJobStatus;
  fileName: string;
  previewUrl: string;
  objectPath?: string;
  mimeType?: string;
  progress: number;
  error?: string;
  retries: number;
  attach?: UploadAttachTarget;
  /** Set after objectPath attached to entity in DB */
  applied?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type UploadJobListener = (jobs: UploadJob[]) => void;

export type InvalidateListener = (queryKeys: string[][]) => void;

export const DRESS_UPLOAD_QUERY_KEYS: string[][] = [
  ["cms-products"],
  ["cms-categories"],
];
