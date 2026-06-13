import sys
import os

file_path = r"D:\CODE NGAY 6-6\exports\migration_pack_20260606_1941\project\artifacts\amazing-studio\src\pages\public\rental-public.tsx"

# Read with UTF-8
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

original = content

# Patch 1: Overlay price - show sellPrice if available, otherwise rentalPrice
old1 = '''              {d.rentalPrice > 0 && (
                <p className="text-white/80 text-xs mt-1.5 tracking-wide">
                  GiA? thuA?ª: {formatVND(d.rentalPrice)}
                </p>
              )}'''

new1 = '''              {d.rentalPrice > 0 && (
                <p className="text-white/80 text-xs mt-1.5 tracking-wide">
                  {d.sellPrice ? (
                    <>GiA¡ bA n: <span className="font-semibold">{formatVND(d.sellPrice)}</span></>
                  ) : (
                    <>GiA? thuA?ª: {formatVND(d.rentalPrice)}</>
                  )}
                </p>
              )}'''

if old1 in content:
    content = content.replace(old1, new1)
    print("Patch 1 OK - overlay price")
else:
    print("Patch 1 FAILED - pattern not found")
    sys.exit(1)

# Patch 2: Add discount badge after outfitTag badge, before closing of relative div
old2 = '''        {d.outfitTag && (
          <div className="absolute top-1.5 left-1.5 sm:top-3 sm:left-3 z-10 scale-90 sm:scale-100 origin-top-left">
            <OutfitTagBadge tag={d.outfitTag} size="sm" />
          </div>
        )}
      </div>

      <div className="px-2 py-2 sm:px-4 sm:py-3 border-t border-neutral-100/80 bg-white">'''

new2 = '''        {d.outfitTag && (
          <div className="absolute top-1.5 left-1.5 sm:top-3 sm:left-3 z-10 scale-90 sm:scale-100 origin-top-left">
            <OutfitTagBadge tag={d.outfitTag} size="sm" />
          </div>
        )}
        {d.sellPrice && (
          <div className="absolute top-1.5 right-1.5 sm:top-3 sm:right-3 z-10">
            <span className="bg-rose-500 text-white text-[9px] sm:text-[10px] font-semibold px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-full shadow-sm">
              GiA?m giA?
            </span>
          </div>
        )}
      </div>

      <div className="px-2 py-2 sm:px-4 sm:py-3 border-t border-neutral-100/80 bg-white">'''

if old2 in content:
    content = content.replace(old2, new2)
    print("Patch 2 OK - discount badge")
else:
    print("Patch 2 FAILED - pattern not found")
    sys.exit(1)

# Patch 3: Footer price section - show original strikethrough + discounted price
old3 = '''        {d.rentalPrice > 0 && (
          <p className="text-[11px] sm:text-sm text-neutral-800 mt-1 sm:mt-2 leading-tight">
            <span className="text-neutral-500 text-[10px] sm:text-xs">GiA? thuA?ª </span>
            <span className="font-semibold sm:font-medium">{formatVND(d.rentalPrice)}</span>
          </p>
        )}'''

new3 = '''        {d.rentalPrice > 0 && (
          <p className="mt-1 sm:mt-2 leading-tight">
            {d.sellPrice ? (
              <>
                <span className="text-[11px] sm:text-sm font-semibold sm:font-medium text-rose-600">
                  {formatVND(d.sellPrice)}
                </span>
                <span className="text-[10px] sm:text-xs text-neutral-400 line-through ml-1.5 sm:ml-2">
                  {formatVND(d.rentalPrice)}
                </span>
              </>
            ) : (
              <span className="text-[11px] sm:text-sm text-neutral-800">
                <span className="text-neutral-500 text-[10px] sm:text-xs">GiA? thuA?ª </span>
                <span className="font-semibold sm:font-medium">{formatVND(d.rentalPrice)}</span>
              </span>
            )}
          </p>
        )}'''

if old3 in content:
    content = content.replace(old3, new3)
    print("Patch 3 OK - footer price")
else:
    print("Patch 3 FAILED - pattern not found")
    sys.exit(1)

# Write back with UTF-8
with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("All patches applied successfully")
