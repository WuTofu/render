export interface Env {
  R2_BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  CACHE_CONTROL?: string;
  PATH_PREFIX?: string;
  INDEX_FILE?: string;
  NOTFOUND_FILE?: string;
  DIRECTORY_LISTING?: boolean;
  ITEMS_PER_PAGE?: number;
  HIDE_HIDDEN_FILES?: boolean;
  DIRECTORY_CACHE_CONTROL?: string;
  LOGGING?: boolean;
  R2_RETRIES?: number;
}
