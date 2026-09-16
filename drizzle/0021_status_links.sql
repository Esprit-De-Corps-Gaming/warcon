ALTER TABLE "webhooks" ADD COLUMN "status_interval_s" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "status_link_status" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "status_link_stats" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "status_link_panel" boolean DEFAULT false NOT NULL;