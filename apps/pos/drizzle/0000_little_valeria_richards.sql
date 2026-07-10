CREATE TABLE `cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`sale_id` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cash_movements_session` ON `cash_movements` (`session_id`);--> statement-breakpoint
CREATE TABLE `cash_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`cashier_id` text NOT NULL,
	`opened_at` text NOT NULL,
	`closed_at` text,
	`counted_cents` integer,
	`expected_cents` integer,
	`over_short_cents` integer
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`device_seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`synced_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_device_seq_unique` ON `outbox` (`device_seq`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`method` text NOT NULL,
	`amount_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_payments_sale` ON `payments` (`sale_id`);--> statement-breakpoint
CREATE TABLE `product_barcodes` (
	`barcode` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category_id` text,
	`scale_item_code` text,
	`is_weighable` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`tax_codes` text NOT NULL,
	`active` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_products_scale_code` ON `products` (`scale_item_code`);--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sale_lines` (
	`id` text NOT NULL,
	`sale_id` text NOT NULL,
	`product_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`gross_cents` integer NOT NULL,
	`discount_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`tax_codes` text NOT NULL,
	PRIMARY KEY(`sale_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`cash_session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`total_cents` integer NOT NULL,
	`due_cents` integer NOT NULL,
	`change_cents` integer NOT NULL,
	`cash_rounding_cents` integer NOT NULL,
	`input` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`kind` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`sale_id` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_stock_movements_product` ON `stock_movements` (`product_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `taxes` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`included_in_price` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`pin_hash` text NOT NULL,
	`active` integer NOT NULL
);
