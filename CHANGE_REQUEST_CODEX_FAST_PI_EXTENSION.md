# Запрос на изменение: расширение pi для Codex Fast mode

Нужно добавить расширение pi, которое включает Codex Fast mode для провайдера `openai-codex` при входе через ChatGPT OAuth. Изменение нужно, потому что pi не имеет встроенной команды `/fast` и не читает `~/.codex/config.toml`, а Fast mode управляется полем запроса к Codex backend.

## Термины и сокращения

- DEF-01: `openai-codex` — провайдер pi для ChatGPT Plus/Pro Codex через OAuth.
- DEF-02: Codex Fast mode — режим OpenAI Codex, который ускоряет поддерживаемые модели за повышенный расход кредитов.
- DEF-03: `service_tier: "priority"` — значение, которое должно попадать в payload запроса pi для включения Fast mode на уровне backend.
- DEF-04: `service_tier = "fast"` — значение конфигурации Codex CLI, которое Codex CLI перед отправкой запроса преобразует в `service_tier: "priority"`.

## Область изменения

Входит в область:
- ISP-01: Создать расширение pi, которое добавляет `service_tier: "priority"` в payload только для `openai-codex`.
- ISP-02: Ограничить включение Fast mode моделями `gpt-5.4` и `gpt-5.5`.
- ISP-03: Добавить безопасную проверку, которая не выводит токены, headers и полный payload.

Не входит в область:
- OSP-01: Не изменять исходный код установленного pi.
- OSP-02: Не изменять `~/.codex/config.toml`, потому что этот файл относится к Codex CLI, а не к pi.
- OSP-03: Не применять настройку к провайдеру `openai`, потому что OpenAI docs указывают, что Fast mode credits недоступны при API key.

## Запрошенные изменения

- FRQ-01: Расширение должно использовать hook `before_provider_request`.
- FRQ-02: Расширение должно проверять `ctx.model.provider === "openai-codex"`.
- FRQ-03: Расширение должно применять изменение только для `ctx.model.id` из набора `gpt-5.4`, `gpt-5.5`.
- FRQ-04: Расширение должно проверять, что `event.payload` является JSON object.
- FRQ-05: Расширение должно возвращать копию payload с добавленным или заменённым полем `service_tier: "priority"`.
- FRQ-06: Расширение не должно менять `model`, `reasoning`, `reasoning.effort`, `instructions`, `input`, `tools`, `headers`, `auth` и `transport`.

Ожидаемый код расширения:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const fastCapableCodexModels = new Set(["gpt-5.4", "gpt-5.5"]);

export default function codexFastMode(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;

    if (model?.provider !== "openai-codex") return;
    if (!fastCapableCodexModels.has(model.id)) return;
    if (!isObjectPayload(event.payload)) return;

    return {
      ...event.payload,
      service_tier: "priority",
    };
  });
}

function isObjectPayload(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}
```

## Затронутые области

- CMP-01: pi extensions — будет добавлен новый пользовательский extension.
- CMP-02: `openai-codex` provider payload — будет изменено только поле `service_tier` перед отправкой запроса.
- CMP-03: Отображение стоимости в pi — может зависеть от того, вернёт ли backend поле `response.service_tier`.

## Ограничения и риски

- CNS-01: Расширение не должно логировать полный payload, headers, токены и переменные окружения.
- RSK-01: Backend может отклонить `service_tier: "priority"`, если у аккаунта нет доступа к Fast mode или модель не поддерживает режим.
- RSK-02: pi может показать неточную стоимость, если backend не вернёт `response.service_tier`.
- RSK-03: Применение к неподдерживаемым моделям может дать ошибку или не включить Fast mode.

## Критерии приёмки

- ACC-01: Для `openai-codex/gpt-5.4` extension добавляет `service_tier: "priority"` в payload.
- ACC-02: Для `openai-codex/gpt-5.5` extension добавляет `service_tier: "priority"` в payload.
- ACC-03: Для моделей вне `gpt-5.4` и `gpt-5.5` payload не изменяется.
- ACC-04: Для провайдеров кроме `openai-codex` payload не изменяется.
- ACC-05: Минимальный запрос `Reply with exactly: ok` успешно выполняется на поддерживаемой модели или возвращает понятную ошибку backend о доступе или service tier.
- ACC-06: Проверочный запуск выводит только provider, model и `service_tier=priority`.

## Предположения

- ASM-01: Пользователь использует pi с ChatGPT OAuth для `openai-codex`. Проверка: `/model` в pi показывает выбранный provider `openai-codex`.
- ASM-02: У пользователя есть доступ к `gpt-5.4` или `gpt-5.5`. Проверка: список моделей pi или `/model` содержит одну из этих моделей.

## Открытые вопросы

- QST-01: Возвращает ли backend `response.service_tier: "priority"` при запросе через pi? Влияет на точность стоимости в pi. Решение: выполнить один минимальный запрос с безопасным проверочным extension.
- QST-02: Есть ли у конкретного аккаунта доступ к Fast mode credits? Влияет на успешность запроса. Решение: выполнить один минимальный запрос на `gpt-5.4` или `gpt-5.5`.

## Ссылки

- REF-01: `https://developers.openai.com/codex/speed` — описание Codex Fast mode, поддерживаемые модели и ограничения API key.
- REF-02: `https://developers.openai.com/codex/config-reference` — значения `service_tier` для Codex CLI config.
- REF-03: `https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs` — маппинг `ServiceTier::Fast` в payload `service_tier: "priority"`.
- REF-04: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` — описание hook `before_provider_request`.
- REF-05: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js` — построение payload для `openai-codex`.
