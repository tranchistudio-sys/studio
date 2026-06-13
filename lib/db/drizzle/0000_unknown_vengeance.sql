CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"custom_code" text,
	"name" text NOT NULL,
	"gender" text,
	"phone" text,
	"email" text,
	"facebook" text,
	"zalo" text,
	"address" text,
	"source" text DEFAULT 'other' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avatar" text,
	"notes" text,
	"customer_rank" text DEFAULT 'new' NOT NULL,
	"facebook_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customers_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "booking_change_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"field_changed" text DEFAULT 'schedule' NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text,
	"changed_by_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"type" text DEFAULT 'addon' NOT NULL,
	"title" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"sold_by_staff_id" integer,
	"is_active" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_code" text,
	"customer_id" integer NOT NULL,
	"shoot_date" date NOT NULL,
	"shoot_time" text,
	"service_category" text DEFAULT 'wedding' NOT NULL,
	"package_type" text NOT NULL,
	"location" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"surcharges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_amount" numeric(12, 2) NOT NULL,
	"deposit_amount" numeric(12, 2) NOT NULL,
	"paid_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"assigned_staff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"internal_notes" text,
	"notes" text,
	"parent_id" integer,
	"service_label" text,
	"is_parent_contract" boolean DEFAULT false NOT NULL,
	"photo_count" integer,
	"banner_url" text,
	"included_retouched_photos_snapshot" integer DEFAULT 0 NOT NULL,
	"service_package_id" integer,
	"required_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deductions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_staff_id" integer,
	"additional_services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"category_id" integer,
	"color" text NOT NULL,
	"size" text NOT NULL,
	"style" text,
	"rental_price" numeric(12, 2) NOT NULL,
	"deposit_required" numeric(12, 2) NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"rental_status" text DEFAULT 'san_sang' NOT NULL,
	"condition" text DEFAULT 'tot' NOT NULL,
	"outfit_tag" text,
	"notes" text,
	"image_url" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dresses_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "rentals" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"dress_id" integer NOT NULL,
	"rental_date" date NOT NULL,
	"return_date" date NOT NULL,
	"actual_return_date" date,
	"rental_price" numeric(12, 2) NOT NULL,
	"deposit_paid" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'rented' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_dresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"dress_id" integer NOT NULL,
	"outfit_code" text NOT NULL,
	"outfit_name" text NOT NULL,
	"outfit_image" text,
	"category" text,
	"size" text,
	"rental_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"pickup_date" date NOT NULL,
	"return_date" date NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer,
	"rental_id" integer,
	"amount" numeric(12, 2) NOT NULL,
	"payment_method" text NOT NULL,
	"payment_type" text NOT NULL,
	"collector_name" text,
	"bank_name" text,
	"proof_image_url" text,
	"proof_image_urls" text[] DEFAULT '{}',
	"paid_date" text,
	"notes" text,
	"paid_at" timestamp DEFAULT now() NOT NULL,
	"payer_name" text,
	"payer_phone" text,
	"description" text,
	"ad_hoc_category" text,
	"status" text DEFAULT 'active',
	"voided_at" timestamp,
	"voided_by" text,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"role" text DEFAULT 'assistant' NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email" text,
	"avatar" text,
	"banner" text,
	"cover_image_url" text,
	"salary" text,
	"base_salary_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"salary_type" text DEFAULT 'fixed' NOT NULL,
	"commission_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"join_date" date,
	"is_active" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"staff_type" text DEFAULT 'official' NOT NULL,
	"attendance_enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"username" text,
	"password_hash" text,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'other' NOT NULL,
	"assignee_id" integer,
	"booking_id" integer,
	"service_package_id" integer,
	"role" text,
	"task_type" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"due_date" date,
	"completed_at" timestamp,
	"notes" text,
	"cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"customer_name" text,
	"phone" text,
	"title" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"surcharges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deductions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"final_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"deposit_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"valid_until" date,
	"expected_date" date,
	"expected_time" text,
	"notes" text,
	"converted_booking_id" integer,
	"converted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_job_splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"role" text NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"rate_type" text DEFAULT 'fixed' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"category" text DEFAULT 'other' NOT NULL,
	"description" text,
	"type" text DEFAULT 'package' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"cost_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"duration" text,
	"includes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"description" text NOT NULL,
	"payment_method" text DEFAULT 'cash' NOT NULL,
	"transaction_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'operational' NOT NULL,
	"category" text NOT NULL,
	"cost_class" text DEFAULT 'operating' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"description" text NOT NULL,
	"booking_id" integer,
	"payment_method" text DEFAULT 'cash' NOT NULL,
	"expense_date" date NOT NULL,
	"expense_at" timestamp,
	"expense_code" text,
	"receipt_url" text,
	"receipt_urls" text[] DEFAULT '{}',
	"bank_name" text,
	"bank_account" text,
	"created_by" text,
	"notes" text,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_by_staff_id" integer,
	"approved_by_staff_id" integer,
	"paid_by_staff_id" integer,
	"paid_from" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"contract_code" text,
	"booking_id" integer,
	"customer_id" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_value" numeric DEFAULT '0',
	"signed_at" date,
	"expires_at" date,
	"file_url" text,
	"notes" text,
	"signature_image_url" text,
	"signer_name" text,
	"signer_phone" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payrolls" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"base_salary" numeric(12, 2) DEFAULT '0' NOT NULL,
	"show_bonus" numeric(12, 2) DEFAULT '0' NOT NULL,
	"commission" numeric(12, 2) DEFAULT '0' NOT NULL,
	"bonus" numeric(12, 2) DEFAULT '0' NOT NULL,
	"deductions" numeric(12, 2) DEFAULT '0' NOT NULL,
	"advance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"net_salary" numeric(12, 2) DEFAULT '0' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" integer,
	"name" text NOT NULL,
	"quantity" text DEFAULT '1' NOT NULL,
	"unit" text,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "service_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer,
	"code" text,
	"name" text NOT NULL,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"print_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"operating_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"sale_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"description" text,
	"notes" text,
	"addons" text,
	"products" text,
	"service_type" text,
	"photo_count" integer DEFAULT 1 NOT NULL,
	"includes_makeup" integer DEFAULT 1 NOT NULL,
	"included_retouched_photos" integer DEFAULT 0 NOT NULL,
	"default_editing_days" integer,
	"requires_post_production" boolean DEFAULT false NOT NULL,
	"requires_printing" boolean DEFAULT false NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surcharges" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"unit" text DEFAULT 'lần' NOT NULL,
	"description" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_allowances" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"role" text,
	"service_booking_id" integer,
	"allowance_type" text NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_cast_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"role" text NOT NULL,
	"package_id" integer NOT NULL,
	"amount" numeric(12, 2),
	"rate_type" text DEFAULT 'fixed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_job_earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"role" text NOT NULL,
	"service_key" text DEFAULT '' NOT NULL,
	"service_name" text DEFAULT '' NOT NULL,
	"rate" numeric(12, 2) DEFAULT '0' NOT NULL,
	"earned_date" date NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payroll_id" integer,
	"service_booking_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_kpi_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer,
	"metric" text DEFAULT 'jobs_count' NOT NULL,
	"target_value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"bonus_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"period" text DEFAULT 'monthly' NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_rate_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"role" text NOT NULL,
	"task_key" text NOT NULL,
	"task_name" text NOT NULL,
	"rate" numeric(12, 2),
	"rate_type" text DEFAULT 'fixed' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_salary_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"service_key" text NOT NULL,
	"role" text NOT NULL,
	"rate" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_salary_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_key" text NOT NULL,
	"service_name" text NOT NULL,
	"role" text NOT NULL,
	"rate" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_internal_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"skills_strong" text,
	"work_notes" text,
	"internal_rating" integer,
	"general_notes" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_leave_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by_name" text,
	"reviewed_at" timestamp,
	"notes" text,
	"leave_type" text DEFAULT 'off',
	"session" text DEFAULT 'full_day',
	"start_time" time,
	"end_time" time,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photoshop_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_code" text NOT NULL,
	"booking_id" integer,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_phone" text DEFAULT '',
	"service_name" text DEFAULT '',
	"assigned_staff_id" integer,
	"assigned_staff_name" text DEFAULT '',
	"shoot_date" text DEFAULT '',
	"received_file_date" text DEFAULT '',
	"internal_deadline" text DEFAULT '',
	"customer_deadline" text DEFAULT '',
	"deadline_system" text,
	"status" text DEFAULT 'chua_nhan' NOT NULL,
	"progress_percent" real DEFAULT 0 NOT NULL,
	"total_photos" integer DEFAULT 0,
	"done_photos" integer DEFAULT 0,
	"notes" text DEFAULT '',
	"photoshop_note" text DEFAULT '',
	"extra_retouch_price" integer DEFAULT 0,
	"extra_photos_requested" integer,
	"drive_link" text DEFAULT '',
	"print_notes" text DEFAULT '',
	"da_xuat_in" boolean DEFAULT false NOT NULL,
	"chi_phi_phat_sinh" integer DEFAULT 0,
	"mo_ta_phat_sinh" text DEFAULT '',
	"detail_photos_count" integer DEFAULT 0,
	"detail_photos_rate" integer DEFAULT 12000,
	"party_photos_count" integer DEFAULT 0,
	"party_photos_rate" integer DEFAULT 1000,
	"is_active" boolean DEFAULT true NOT NULL,
	"completed_by" integer,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "internal_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_id" integer NOT NULL,
	"sender_staff_id" integer,
	"sender_name" text DEFAULT 'Hệ thống' NOT NULL,
	"content" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "message_rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'group' NOT NULL,
	"link_type" text DEFAULT '',
	"link_id" integer,
	"created_by_staff_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"recipient_staff_id" integer,
	"sender_staff_id" integer,
	"type" text DEFAULT 'info' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link_type" text DEFAULT '',
	"link_id" integer,
	"booking_id" integer,
	"is_read" boolean DEFAULT false NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"joined_at" timestamp DEFAULT now(),
	"last_read_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "attendance_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"date" date NOT NULL,
	"type" text DEFAULT 'bonus' NOT NULL,
	"category" text,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reason" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_late_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"late_from_time" text DEFAULT '08:00' NOT NULL,
	"late_to_time" text,
	"penalty_amount" numeric(12, 2),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_log_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"log_id" integer NOT NULL,
	"override_time" text,
	"override_is_late" integer,
	"reason" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"type" text DEFAULT 'check_in' NOT NULL,
	"method" text DEFAULT 'qr' NOT NULL,
	"lat" numeric(10, 7),
	"lng" numeric(10, 7),
	"accuracy_m" numeric(8, 2),
	"distance_m" numeric(8, 2),
	"booking_id" integer,
	"work_type" text,
	"attendance_type" text,
	"location_verified" boolean DEFAULT false NOT NULL,
	"selfie_required" boolean DEFAULT false NOT NULL,
	"qr_required" boolean DEFAULT false NOT NULL,
	"notes" text,
	"checkin_photo_url" text,
	"checkout_photo_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_month_closures" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"staff_id" integer NOT NULL,
	"staff_name" text DEFAULT '' NOT NULL,
	"work_days" integer DEFAULT 0 NOT NULL,
	"on_time_count" integer DEFAULT 0 NOT NULL,
	"late_count" integer DEFAULT 0 NOT NULL,
	"late_penalty_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"forgot_checkout_penalty_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"attendance_bonus_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"overtime_pay" numeric(12, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"closed_at" timestamp DEFAULT now() NOT NULL,
	"closed_by" integer,
	"closed_by_name" text,
	CONSTRAINT "attendance_month_closures_month_staff_unique" UNIQUE("month","staff_id")
);
--> statement-breakpoint
CREATE TABLE "attendance_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Mặc định' NOT NULL,
	"check_in_from" text DEFAULT '07:30' NOT NULL,
	"check_in_to" text DEFAULT '08:10' NOT NULL,
	"weekly_on_time_bonus" numeric(12, 2) DEFAULT '50000' NOT NULL,
	"overtime_rate_per_hour" numeric(12, 2) DEFAULT '30000' NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_shift_override_staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"override_id" integer NOT NULL,
	"staff_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_shift_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"name" text DEFAULT 'Ca đặc biệt' NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"standard_hours" numeric(4, 2) DEFAULT '8' NOT NULL,
	"flexible_break_hours" numeric(4, 2) DEFAULT '2' NOT NULL,
	"notes" text,
	"scope" text DEFAULT 'all' NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"zalo" text,
	"message" text,
	"last_message" text,
	"last_message_at" timestamp,
	"source" text DEFAULT 'facebook',
	"status" text DEFAULT 'new',
	"type" text DEFAULT 'unknown',
	"channel" text DEFAULT 'inbox',
	"facebook_user_id" text,
	"avatar_url" text,
	"notes" text,
	"ai_per_thread_enabled" boolean,
	"ai_mode" text DEFAULT 'active',
	"customer_id" integer,
	"current_script_id" integer,
	"current_sale_step" integer,
	"service_group" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "crm_leads_facebook_user_id_unique" UNIQUE("facebook_user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_script_qa_rows_bak_20260503080544" (
	"id" integer,
	"script_id" integer,
	"step" integer,
	"question" text,
	"answer" text,
	"sort_order" integer
);
--> statement-breakpoint
CREATE TABLE "ai_script_qa_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"script_id" integer,
	"step" integer NOT NULL,
	"question" text,
	"answer" text,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "ai_script_steps_bak_20260503080544" (
	"id" integer,
	"script_id" integer,
	"step" integer,
	"step_label" text,
	"content" text,
	"variants_json" text,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ai_script_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"script_id" integer NOT NULL,
	"step" integer NOT NULL,
	"step_label" text,
	"content" text,
	"variants_json" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ai_service_scripts_bak_20260503080544" (
	"id" integer,
	"name" text,
	"price_content" text,
	"is_active" boolean,
	"created_at" timestamp,
	"updated_at" timestamp,
	"price_images" text,
	"ai_rules" text,
	"follow_up_message" text,
	"step_follow_up_messages" jsonb,
	"ai_settings" jsonb,
	"conversation_examples" jsonb,
	"step_follow_up_slots" jsonb,
	"service_group" text
);
--> statement-breakpoint
CREATE TABLE "ai_service_scripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_content" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"price_images" text,
	"ai_rules" text,
	"follow_up_message" text,
	"step_follow_up_messages" jsonb,
	"ai_settings" jsonb,
	"conversation_examples" jsonb,
	"step_follow_up_slots" jsonb,
	"service_group" text
);
--> statement-breakpoint
CREATE TABLE "ai_test_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"type" text,
	"decision" text,
	"current_step" integer,
	"debug_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_test_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"customer_name" text DEFAULT 'Khách Test' NOT NULL,
	"script_id" integer,
	"current_script_id" integer,
	"current_sale_step" integer,
	"script_updated_at" timestamp with time zone,
	"last_customer_message_at" timestamp with time zone,
	"follow_up_count" integer DEFAULT 0 NOT NULL,
	"last_follow_up_at" timestamp with time zone,
	"last_follow_up_step" integer,
	"last_follow_up_slot_index" integer,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_message_preview" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fb_inbox_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"facebook_user_id" text NOT NULL,
	"direction" text NOT NULL,
	"message" text NOT NULL,
	"sent_status" text DEFAULT 'received' NOT NULL,
	"ai_decision" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"mid" text,
	"sent_by" text
);
--> statement-breakpoint
CREATE TABLE "cms_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"parent_id" integer,
	"name" text NOT NULL,
	"slug" text,
	"cover_image_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gallery_albums" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"description" text,
	"cover_image_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"category_id" integer,
	"tags_text" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gallery_photos" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"image_url" text NOT NULL,
	"caption" text,
	"mime_type" text,
	"status" text DEFAULT 'visible' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_change_log" ADD CONSTRAINT "booking_change_log_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_change_log" ADD CONSTRAINT "booking_change_log_changed_by_id_staff_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_sold_by_staff_id_staff_id_fk" FOREIGN KEY ("sold_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_package_id_service_packages_id_fk" FOREIGN KEY ("service_package_id") REFERENCES "public"."service_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_dress_id_dresses_id_fk" FOREIGN KEY ("dress_id") REFERENCES "public"."dresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_dresses" ADD CONSTRAINT "booking_dresses_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_dresses" ADD CONSTRAINT "booking_dresses_dress_id_dresses_id_fk" FOREIGN KEY ("dress_id") REFERENCES "public"."dresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_staff_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_service_package_id_service_packages_id_fk" FOREIGN KEY ("service_package_id") REFERENCES "public"."service_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job_splits" ADD CONSTRAINT "service_job_splits_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_staff_id_staff_id_fk" FOREIGN KEY ("approved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_staff_id_staff_id_fk" FOREIGN KEY ("paid_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_package_id_service_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."service_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_packages" ADD CONSTRAINT "service_packages_group_id_service_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."service_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_allowances" ADD CONSTRAINT "staff_allowances_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_allowances" ADD CONSTRAINT "staff_allowances_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_allowances" ADD CONSTRAINT "staff_allowances_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_cast_rates" ADD CONSTRAINT "staff_cast_rates_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_cast_rates" ADD CONSTRAINT "staff_cast_rates_package_id_service_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."service_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_job_earnings" ADD CONSTRAINT "staff_job_earnings_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_job_earnings" ADD CONSTRAINT "staff_job_earnings_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_job_earnings" ADD CONSTRAINT "staff_job_earnings_payroll_id_payrolls_id_fk" FOREIGN KEY ("payroll_id") REFERENCES "public"."payrolls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_kpi_config" ADD CONSTRAINT "staff_kpi_config_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_rate_prices" ADD CONSTRAINT "staff_rate_prices_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_salary_overrides" ADD CONSTRAINT "staff_salary_overrides_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_internal_notes" ADD CONSTRAINT "staff_internal_notes_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_leave_requests" ADD CONSTRAINT "staff_leave_requests_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_late_rules" ADD CONSTRAINT "attendance_late_rules_rule_id_attendance_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."attendance_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_log_overrides" ADD CONSTRAINT "attendance_log_overrides_log_id_attendance_logs_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."attendance_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_log_overrides" ADD CONSTRAINT "attendance_log_overrides_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_month_closures" ADD CONSTRAINT "attendance_month_closures_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_month_closures" ADD CONSTRAINT "attendance_month_closures_closed_by_staff_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_shift_override_staff" ADD CONSTRAINT "attendance_shift_override_staff_override_id_attendance_shift_overrides_id_fk" FOREIGN KEY ("override_id") REFERENCES "public"."attendance_shift_overrides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_shift_override_staff" ADD CONSTRAINT "attendance_shift_override_staff_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_shift_overrides" ADD CONSTRAINT "attendance_shift_overrides_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customers_facebook" ON "customers" USING btree ("facebook");--> statement-breakpoint
CREATE INDEX "idx_customers_rank" ON "customers" USING btree ("customer_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "photoshop_jobs_booking_active_unique" ON "photoshop_jobs" USING btree ("booking_id") WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_unique" ON "notifications" USING btree ("dedupe_key") WHERE "notifications"."dedupe_key" IS NOT NULL;