-- Chính sách chủ studio xác nhận 2026-08-28:
-- mỗi dịch vụ cưới riêng trong hợp đồng được tính một lần; quà áp theo mốc cao
-- nhất hiện đạt, KHÔNG cộng dồn quà của các mốc thấp hơn; Beauty không eligible.
DO $$
DECLARE
  v_program_id integer;
  v_tier_id integer;
BEGIN
  SELECT id INTO v_program_id FROM wedding_gift_programs
  WHERE name = 'Chương trình quà tặng đặc biệt - Amazing Studio'
  ORDER BY id DESC LIMIT 1;

  IF v_program_id IS NULL THEN
    INSERT INTO wedding_gift_programs (name, description, enabled)
    VALUES (
      'Chương trình quà tặng đặc biệt - Amazing Studio',
      'Quà theo mốc cao nhất 2–3–4–5 dịch vụ cưới; không cộng dồn các mốc; không quy đổi tiền mặt.',
      true
    ) RETURNING id INTO v_program_id;
  ELSE
    UPDATE wedding_gift_programs SET enabled = true, starts_at = NULL, ends_at = NULL,
      description = 'Quà theo mốc cao nhất 2–3–4–5 dịch vụ cưới; không cộng dồn các mốc; không quy đổi tiền mặt.',
      updated_at = now()
    WHERE id = v_program_id;
  END IF;

  INSERT INTO wedding_gift_eligible_groups (program_id, group_id, service_key)
  VALUES
    (v_program_id, 10, 'album_outdoor'),
    (v_program_id, 11, 'album_studio'),
    (v_program_id, 12, 'wedding_gate'),
    (v_program_id, 13, 'wedding_combo_makeup'),
    (v_program_id, 14, 'bridal_makeup'),
    (v_program_id, 16, 'wedding_video'),
    (v_program_id, 17, 'wedding_party'),
    (v_program_id, 19, 'wedding_combo_no_makeup'),
    (v_program_id, 22, 'wedding_combo_basic'),
    (v_program_id, 23, 'wedding_outfit'),
    (v_program_id, 24, 'wedding_combo_full')
  ON CONFLICT (program_id, group_id) DO UPDATE SET is_active = true;

  INSERT INTO wedding_gift_tiers (program_id, minimum_service_count, name, choose_count, sort_order)
  VALUES (v_program_id, 2, 'Mốc 2 dịch vụ cưới', 1, 2)
  ON CONFLICT (program_id, minimum_service_count) DO UPDATE SET name = excluded.name, choose_count = 1, is_active = true
  RETURNING id INTO v_tier_id;
  DELETE FROM wedding_gift_options o WHERE o.tier_id = v_tier_id;
  INSERT INTO wedding_gift_options (tier_id, name, sort_order) VALUES
    (v_tier_id, '10 khung hình mica để bàn', 1),
    (v_tier_id, '2 tranh cao cấp 60 × 90cm', 2);

  INSERT INTO wedding_gift_tiers (program_id, minimum_service_count, name, choose_count, sort_order)
  VALUES (v_program_id, 3, 'Mốc 3 dịch vụ cưới', 1, 3)
  ON CONFLICT (program_id, minimum_service_count) DO UPDATE SET name = excluded.name, choose_count = 1, is_active = true
  RETURNING id INTO v_tier_id;
  DELETE FROM wedding_gift_options o WHERE o.tier_id = v_tier_id;
  INSERT INTO wedding_gift_options (tier_id, name, sort_order) VALUES
    (v_tier_id, '1 áo đi bàn trị giá 1.200.000đ', 1),
    (v_tier_id, 'Áo dài dành cho chú rể', 2),
    (v_tier_id, '6 áo dài quả nam', 3);

  INSERT INTO wedding_gift_tiers (program_id, minimum_service_count, name, choose_count, sort_order)
  VALUES (v_program_id, 4, 'Mốc 4 dịch vụ cưới', 1, 4)
  ON CONFLICT (program_id, minimum_service_count) DO UPDATE SET name = excluded.name, choose_count = 1, is_active = true
  RETURNING id INTO v_tier_id;
  DELETE FROM wedding_gift_options o WHERE o.tier_id = v_tier_id;
  INSERT INTO wedding_gift_options (tier_id, name, sort_order) VALUES
    (v_tier_id, '1 ảnh 60 × 120cm chất liệu mica cao cấp', 1);

  INSERT INTO wedding_gift_tiers (program_id, minimum_service_count, name, choose_count, sort_order)
  VALUES (v_program_id, 5, 'Mốc 5 dịch vụ cưới', 1, 5)
  ON CONFLICT (program_id, minimum_service_count) DO UPDATE SET name = excluded.name, choose_count = 1, is_active = true
  RETURNING id INTO v_tier_id;
  DELETE FROM wedding_gift_options o WHERE o.tier_id = v_tier_id;
  INSERT INTO wedding_gift_options (tier_id, name, sort_order) VALUES
    (v_tier_id, 'May mới 1 cặp áo dài theo mẫu, đúng size dâu rể', 1),
    (v_tier_id, 'May mới 1 bộ saree theo size cô dâu', 2);
END $$;
