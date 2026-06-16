import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const galleryAlbumsTable = pgTable("gallery_albums", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  description: text("description"),
  coverImageUrl: text("cover_image_url"),
  status: text("status").notNull().default("draft"),
  sortOrder: integer("sort_order").notNull().default(0),
  categoryId: integer("category_id"),
  tagsText: text("tags_text"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const galleryPhotosTable = pgTable("gallery_photos", {
  id: serial("id").primaryKey(),
  albumId: integer("album_id").notNull(),
  imageUrl: text("image_url").notNull(),
  caption: text("caption"),
  mimeType: text("mime_type"),
  status: text("status").notNull().default("visible"),
  sortOrder: integer("sort_order").notNull().default(0),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const cmsCategoriesTable = pgTable("cms_categories", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  parentId: integer("parent_id"),
  name: text("name").notNull(),
  slug: text("slug"),
  coverImageUrl: text("cover_image_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type GalleryAlbum = typeof galleryAlbumsTable.$inferSelect;
export type GalleryPhoto = typeof galleryPhotosTable.$inferSelect;
export type CmsCategory = typeof cmsCategoriesTable.$inferSelect;
