# Backup database Replit (trước khi đưa code lên)

## Bước 1 — Export trên Replit

1. Mở project **Amazing-Studio-Manager** trên Replit
2. Tab **Shell** (dưới cùng)
3. Chạy lệnh:

```bash
bash scripts/replit-export-production-dump.sh
```

Nếu báo thiếu URL → lấy Production DB:
- Tab **Database** (phải) → **Production** → **Manage** → **Settings**
- Copy connection string
- Chạy:

```bash
export PRODUCTION_DATABASE_URL="postgresql://..."
bash scripts/replit-export-production-dump.sh
```

## Bước 2 — Tải file về máy Windows

1. Tab **Files** (trái)
2. Tìm file `backup_replit_YYYYMMDD_HHMM.sql`
3. Bấm **⋮** → **Download**
4. Lưu vào ổ D/E (vd: `D:\BACKUP-AMAZING\`)

## Bước 3 — Trước khi Publish (quan trọng!)

Trên tab **Publishing**:
- **TẮT** 「Copy development database to production」
- Chỉ Publish **code**, không ghi đè DB production

## Nếu DB bị hư — phục hồi

Upload file `.sql` lên Replit Files, rồi Shell:

```bash
export PRODUCTION_DATABASE_URL="postgresql://..."
bash scripts/replit-restore-production-dump.sh backup_replit_YYYYMMDD_HHMM.sql
```

(Gõ `YES` để xác nhận)

## Export cả ảnh (tùy chọn)

Trong Replit Agent chat gõ:
> Export DB + images backup

Hoặc tải thư mục `artifacts/data/object-storage` từ Files.


## Export ĐẦY ĐỦ — DB + ảnh (1 file)

Tab **Shell** → dán **một lần**:

```bash
bash scripts/replit-export-full-backup.sh
```

Nếu thiếu URL production:

```bash
export PRODUCTION_DATABASE_URL="postgresql://..."
bash scripts/replit-export-full-backup.sh
```

File ra: `Amazing_Studio_Export_DB_Images_YYYYMMDD_HHMM.tar.gz`

Giải nén trên Windows có:
- `database.sql`
- `artifacts/data/object-storage/uploads/` — toàn bộ ảnh
