# Debates helper — one-click Docker stack.
# First run: `cp .env.example .env`, fill in secrets, then `make up`.
.PHONY: up down logs ps build transcribe restart-bot

up: ## Build + start the whole stack (postgres, redis, api, bot, transcriber-worker)
	docker compose up -d --build

down: ## Stop the stack (containers + network; volumes kept)
	docker compose down

logs: ## Tail logs for all services
	docker compose logs -f

ps: ## Show service status/health
	docker compose ps

build: ## Rebuild images without starting
	docker compose build

restart-bot: ## Rebuild + restart just the bot (after bot code changes)
	docker compose up -d --build discord-bot

# Manually (re)transcribe one session, e.g. an old one with no opt-in marker:
#   make transcribe SESSION=2026-06-14T13-01-47__<uuid>
transcribe:
	docker compose --profile tools run --rm transcriber $(SESSION)
