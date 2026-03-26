.PHONY: start stop restart init seed data logs help

start: ## Start DynamoDB local + admin, init tables, auto-seed if empty, run the app
	docker compose up -d
	sleep 2
	node scripts/init-tables.js
	node scripts/seed.js --if-empty
	node server.js

infra: ## Start DynamoDB local + admin only
	docker compose up -d

init: ## Create DynamoDB tables
	node scripts/init-tables.js

seed: ## Seed sample users and orders (always)
	node scripts/seed.js

data: ## View current data in DynamoDB
	node scripts/view-data.js

app: ## Run the web app + API server
	node server.js

stop: ## Stop Docker containers
	docker compose down

restart: stop infra ## Restart infrastructure and app
	sleep 2
	$(MAKE) app

logs: ## Tail Docker container logs
	docker compose logs -f

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
