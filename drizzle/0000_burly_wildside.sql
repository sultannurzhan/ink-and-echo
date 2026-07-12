CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`name` text NOT NULL,
	`seat` integer NOT NULL,
	`token_hash` text NOT NULL,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`room_code`) REFERENCES `rooms`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_room_seat_uq` ON `players` (`room_code`,`seat`);--> statement-breakpoint
CREATE INDEX `players_room_idx` ON `players` (`room_code`);--> statement-breakpoint
CREATE TABLE `room_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`ordinal` integer NOT NULL,
	`room_version` integer NOT NULL,
	`round` integer NOT NULL,
	`author_player_id` text NOT NULL,
	`kind` text NOT NULL,
	`text_content` text,
	`image_data` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_code`) REFERENCES `rooms`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_entries_room_ordinal_uq` ON `room_entries` (`room_code`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_entries_room_version_uq` ON `room_entries` (`room_code`,`room_version`);--> statement-breakpoint
CREATE INDEX `room_entries_room_idx` ON `room_entries` (`room_code`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`host_player_id` text NOT NULL,
	`status` text NOT NULL,
	`settings_json` text NOT NULL,
	`game_state_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
