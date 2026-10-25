# Interface localization

ORE loads language packs at runtime. English is the bundled, authoritative fallback. Russian is a complete built-in translation, authored from ORE’s product terminology and maintained with application changes. No imported file is needed.

## Using languages

Use **Settings → Language → Interface language**. Language selectors are not shown in the header or **Chat details**. Switching language updates mounted controls without reloading the page. The composer draft remains in place when navigating to Settings and back. Each browser remembers its selection in `ore-interface-language`; it does not change another device's language. On first use, ORE chooses an available match for the browser's language preferences, otherwise English.

**Download translation template** downloads the current English catalog with Russian metadata and all required Russian plural variants. Translate the values, keeping keys and named placeholders unchanged. Untranslated keys can be removed altogether to use English fallback. Import the JSON through **Import language file**; replacing an installed custom pack requires confirmation and its captured revision. Malformed JSON, invalid metadata/structure, unsafe keys, unsupported formats and file-limit violations reject the whole file with an explanation; failed writes also preserve the previous file. Incompatible individual entries do not reject the pack: valid translations load and Settings opens a report listing each excluded key and its reason, including expected and supplied placeholders. The report remains available after reload/restart and covers discovered packs as well as imports. Large reports show 20 entries per page. Importing does not select a different language automatically.

To extend a partial translation after an app update, select it under **Interface language**, then choose **Download extended translation**. This downloads `<locale>.json` from the currently loaded pack, preserving its metadata, existing translations (including incompatible entries) and unknown keys while filling missing current entries and required plural forms with English text. Translate the added values and import the file to update the installed pack. Downloading does not change the installed file or its coverage count. The button is disabled for the bundled English fallback and while language operations are running; the original template download remains available for starting a new translation.

Alternatively, place a UTF-8 `<locale>.json` file in the installation's `languages/` directory; open Settings to discover it automatically. Examples are `ru.json`, `de.json` and `pt-BR.json`. The filename must match its canonical locale. A custom `ru.json` overrides the complete built-in Russian pack; remove that file to return to the maintained built-in translation. Source development uses the repository's ignored `languages/` directory. Portable installations use `<ORE_HOME>/languages`, independently of database overrides and versioned `app/` directories. Updates preserve this directory. No rebuild or server restart is required.

Reloading also updates the active pack. A removed selected language falls back to English, retaining the browser preference so it can be selected again after restoration. A structurally malformed edit retains that server process's last structurally valid pack and displays a notice. After restart, a structurally invalid custom pack uses its bundled fallback, if present; other invalid packs are omitted. Settings refreshes language files when opened and every five seconds while open; polling stops when Settings closes. This uses the existing authenticated reload API, without a filesystem watcher or a Reload button.

## Pack format

```json
{
  "formatVersion": 1,
  "locale": "ru",
  "nativeName": "Русский",
  "direction": "ltr",
  "messages": {
    "language.heading": "Язык",
    "app.libraries": "Библиотеки"
  }
}
```

`locale` is a canonical BCP 47 language tag. `nativeName` is the language's own display name. `direction` is `ltr` or `rtl`; it sets the document direction. Right-to-left layout qualification for real translations remains pending. Format version 1 stores strings only; only plain text with supported named placeholders is activated. HTML, nested translation references and unsupported interpolation syntax remain inert and are reported. Translation files cannot load executable modules or model instructions. English's `en` identifier is reserved; a custom English variant can use its own locale identifier.

Files are limited to 2 MB each, 20 MB in total, 10,000 entries per file and 100 installed languages. Symlinked files/directories are unsupported. Unknown keys remain inert, allowing packs from another application version to remain useful. Missing and unknown messages use the current English catalog or the diagnostic's retained fallback. Empty or whitespace-only translations are retained but excluded from active messages and reported; omit the key to use English without a warning. Unknown entries remain in files and exports but are never registered as runtime resources, including for retained historical diagnostics.

Placeholders such as `{{language}}` and `{{count}}` must match the English entry exactly. Unsupported HTML, nested translation references and interpolation syntax are excluded and reported. Values are interpolated as plain text; they cannot override translation-engine options. A plural group may be omitted entirely, but a translated group must provide every cardinal form required by its language. If any form is missing or incompatible, the entire group uses English and each excluded supplied entry is reported. For Russian:

```json
{
  "counts.turns_one": "{{count}} ход",
  "counts.turns_few": "{{count}} хода",
  "counts.turns_many": "{{count}} ходов",
  "counts.turns_other": "{{count}} хода"
}
```

The download template includes all of these variants. Number/date formatting uses the chosen locale and the browser's existing timezone. Stored timestamps and numeric values remain unchanged.

The saved pack and the active message set are separate. Discovery and import retain all supplied strings, including incompatible and unknown entries; no placeholder is automatically removed or rewritten. Coverage counts only compatible current English-catalog entries, excluding rejected plural groups and unknown keys. The authenticated/public pack read returns the retained pack for export; the browser runs the same shared validator before registering resources. Status exposes per-language structured issue descriptors, so reports update with the interface language. Correct entries in the downloaded file and reimport it to clear the report. A failed or conflicting replacement keeps the previous committed pack and report.

## Scope and data boundaries

Interface controls, help, tooltips, accessibility labels and authored messages use the English catalog in `src/shared/localization-en.ts`. Application diagnostics can carry a `LocalizedMessage` containing a stable key, scalar parameters and the original English fallback. The browser formats this descriptor when rendering; core/persistence/provider code never reads a user's locale. JSON/property/protocol identifiers and raw technical inspection data remain literal.

Story text, names, imported cards, lore prose, editable presets/model instructions, reasoning, generated summaries and historical provider request bodies remain literal. Localizing the interface does not translate existing saved content or influence summary language, input selection, token budgeting or provider parameters. Newly created default titles can use the interface language; existing titles are never rewritten.

Migration 15 adds a nullable `generations.error_message` field. New terminal outcomes can retain translation metadata alongside `error`; old errors receive no inferred identity and retain their original wording. Preparation JSON supports equivalent optional metadata. Import receipts retain diagnostic metadata across exact-command retries. Backup validation accepts these optional structures, and schemas 12, 13, 14 and 15 remain importable. Older schema definitions are reconstructed and checked without modifying uploads. Language packs and the browser language preference are outside chat backups/import/wipe; saved outcome metadata remains part of the corresponding historical record.

## Implementation and extending coverage

- `src/shared/localization.ts`: pack/descriptor contracts, canonical locales, placeholder and plural validation, English diagnostic construction and template generation.
- `src/shared/localization-en.ts`: stable English message keys. Add new entries explicitly; changing English wording must not rename existing keys.
- `src/shared/localization-ru.ts`: complete maintained Russian catalog. Its type requires every English key and every Russian plural form; catalog tests also check exact key coverage and placeholder compatibility.
- `src/shared/localization-validation.ts`: presentation descriptors for Zod issues and explicitly authored validation messages.
- `src/server/languages.ts`: bounded discovery, last-valid recovery, revision checks and private atomic file replacement.
- `src/web/localization.tsx`: i18next/react-i18next instance, browser preference, stale-response protection and render-time message formatting.
- `src/web/LanguageSettings.tsx`: selection, template download, import and automatic refresh.

Use `t(key, params)` for render-time labels and subscribe with `useLocale()` in components, including memoized components. Use complete sentences with named placeholders rather than assembling translated words or changing their grammatical case in code. Use `message(key, params)` for saved/transient diagnostic identities, and `formatMessage` when rendering. `useTextState` retains a descriptor through language changes instead of freezing the previously translated string. API errors preserve descriptors through `errorText`.

Extend shared diagnostic schemas together with their producers and receipt/backup consumers. Do not translate domain values, CSS selectors, element IDs, protocol names or user-authored text. Model-bound prose and labels that are themselves part of a saved model request remain outside presentation translation.

## Russian terminology and maintenance

Maintain English and Russian in the same change whenever interface meaning changes. Review the actual caller and surrounding flow rather than translating isolated strings. Prefer natural, concise Russian sentences; preserve distinctions between saving, selecting, preparing and approving memory. Do not translate editable model prompts, saved user titles or protocol identifiers. Retain old diagnostic keys needed by historical records.

| English | Russian | Meaning |
| --- | --- | --- |
| Connection | Подключение | Reusable endpoint, credentials, model and limits |
| Prompt preset | Шаблон промпта | Ordered text blocks and markers |
| Context preset | Пресет контекста | Reusable memory configuration |
| Character / Persona | Персонаж / Персона | Model’s identity / user’s identity |
| Lorebook / lore | Лорбук / лор | Conditional world information |
| Turn / message | Ход / сообщение | Whole user/assistant pair / one part |
| Summary | Сводка | Saved narrative representation of sources |
| Prepare chat / repair summaries | Подготовить чат / исправить сводки | Budget preparation / reviewed dependency repair |
| Verbatim / archived | Дословно / архив | Original text in input / represented through memory |
| Retained alternative | Сохранённая альтернатива | Saved but not active in model input |
| Promotion | Объединение на следующем уровне | Compress a fixed group of summaries |
| Stale / fresh | Устарело / актуально | Structural dependency freshness, not factual quality |

Use complete messages with named parameters, avoiding English grammatical fragments in parameters. All Russian cardinal groups require `one`, `few`, `many`, and `other`. Compile-time coverage and tests prevent omissions and malformed substitutions; linguistic accuracy still requires contextual review.

## Verification

`tests/localization.test.ts` covers runtime file discovery/reload, partial packs, preservation of incompatible entries through discovery/import/restart/export, unsupported/unsafe input, detailed structural errors, placeholder reports and whole-group Russian plural fallback, English/legacy fallback, atomic write failure, stale replacements, authentication/origin checks and populated schema-14 upgrade preservation. Existing persistence tests cover import receipt replay and backup compatibility. Built-in Russian browser checks exercise selection without import, settings, libraries, editors, memory, request inspection, language persistence and unchanged model input at desktop and phone-sized widths. Additional browser localization tests use a small synthetic Russian pack at desktop and phone-sized widths; they cover partial import/replacement, incompatible-entry reports and pagination, preserved export entries, correction/reimport, malformed-file rejection, live switching, fallback and composer draft preservation. These are structural/interaction checks, not a review of translation quality or actual phone behavior.

Run `npm run check` with the supported Node runtime and permission to start isolated local test servers. No real provider credentials are needed.
