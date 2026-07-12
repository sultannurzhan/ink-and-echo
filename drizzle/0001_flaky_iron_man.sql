CREATE TABLE `rate_limit_buckets` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_buckets_expiry_idx` ON `rate_limit_buckets` (`expires_at`);--> statement-breakpoint
ALTER TABLE `players` ADD `recovery_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `players` ADD `last_seen_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `players` ADD `left_at` integer;--> statement-breakpoint
CREATE INDEX `players_last_seen_idx` ON `players` (`last_seen_at`);--> statement-breakpoint
UPDATE `players` SET `last_seen_at` = `joined_at` WHERE `last_seen_at` = 0;--> statement-breakpoint
ALTER TABLE `rooms` ADD `last_activity_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `rooms_expiry_idx` ON `rooms` (`expires_at`);--> statement-breakpoint
UPDATE `rooms` SET
	`last_activity_at` = `updated_at`,
	`expires_at` = `updated_at` + CASE
		WHEN `status` = 'waiting' THEN 86400000
		WHEN `status` = 'playing' THEN 172800000
		ELSE 604800000
	END
WHERE `last_activity_at` = 0 OR `expires_at` = 0;
