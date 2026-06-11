export type UploadJobStatus = "pending" | "uploading" | "uploaded" | "failed";

/** Entity attach — dressId optional until form saved (save-first flow). */
export type UploadAttachTarget = {
  entity: "dress";
  mode: "album" | "cover";
  dressId?: number;
};

export type UploadJob = {
  id: string;
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
