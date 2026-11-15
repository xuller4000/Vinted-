# Vinted Connector

MCP-Server als Cloudflare Worker, über den Claude (claude.ai, Desktop, Mobile) auf Vinted suchen und Artikel lesen kann. Kein Login, kein eigenes Konto. Nur lesend: Kaufen, Favorisieren oder Nachrichten an Verkäufer gehen damit nicht.

Aufgebaut wie der Kleinanzeigen-Connector (`xuller4000/kleinanzeigen`), mit eigenem Worker `vinted-connector` und eigenem Deploy.

## Tools

| Tool | Zweck |
|---|---|
| `search_items` | Suche mit Begriff, Preisgrenzen, Zustand, Sortierung, Seite und Länderseite (Standard vinted.de). Je Treffer Titel, Preis mit Käuferschutz, Marke, Zustand, Größe und Link |
| `get_item` | Details eines Artikels: Titel, Preis, Marke, Zustand, Beschreibung und die ersten vier Fotos |

## So funktioniert der Zugriff

Vinted hat keine offizielle API. Seit Herbst 2026 gibt es die alten Endpunkte `/api/v2/catalog/items` und `/api/v2/items/<id>` nicht mehr. Die neue Katalog-API auf `api.vinted.<tld>/svc-catalogue/items` wählt den Markt nach der IP des Aufrufers, und Cloudflares Ausgangs-IPs gelten als USA. Von einem Worker aus kämen dort also US-Angebote in USD.

Der Connector liest deshalb die normalen, serverseitig gerenderten Seiten von `www.vinted.<tld>`. Die zeigen immer den Markt der Domain. Bei der Suche ist das die Katalogseite, wo Titel, Marke, Zustand, Größe und Preise im Link-Titel jeder Kachel stehen. Bei einem Artikel ist es die Artikelseite mit JSON-LD und Open-Graph-Tags. Verkäufer, Favoriten und Bewertungen stehen dort nicht mehr drin.

## Einrichtung

### 1. GitHub Secrets

Unter *Settings → Secrets and variables → Actions → New repository secret* drei Secrets anlegen. Die Cloudflare-Werte sind dieselben wie beim Kleinanzeigen-Connector.

| Name | Wert |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare-Token mit der Vorlage *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Account-ID aus dem Cloudflare-Dashboard |
| `CONNECTOR_SECRET` | zufällige Zeichenkette, mindestens 24 Zeichen, z. B. `openssl rand -hex 24` |

Für `CONNECTOR_SECRET` ein eigenes nehmen, nicht das vom Kleinanzeigen-Connector.

### 2. Deploy

*Actions → Deploy to Cloudflare → Run workflow*. Danach deployt jeder Push auf `main` automatisch.

### 3. In Claude einbinden

claude.ai → *Einstellungen → Connectors → Custom Connector hinzufügen*:

- Name: `Vinted`
- URL: `https://vinted-connector.xuller4000.workers.dev/<CONNECTOR_SECRET>/mcp`

OAuth-Felder leer lassen.

## Wenn der Deploy scheitert

Der Workflow prüft das Token vor dem Deploy und schreibt ins Log, was nicht stimmt (gleiche Meldungen wie beim Kleinanzeigen-Connector).

## Grenzen

Vinted drosselt schnell (HTTP 429), vor allem bei vielen Abfragen kurz hintereinander, und Cloudflares Ausgangs-IPs teilen sich viele Nutzer. Der Connector hält die Zahl der Anfragen deshalb klein:

- Suchergebnisse liegen 15 Minuten, Artikel eine Stunde im KV-Speicher `vinted-cache`. Dieselbe Suche mit anderem `per_page` kostet keine neue Anfrage.
- Bei einer Drosselung liefert er den letzten gespeicherten Stand (bis 24 Stunden alt), mit Hinweis auf das Alter. Gibt es keinen, meldet er die Drosselung, statt es weiter zu versuchen.
- Ein kurzes `Retry-After` (bis 3 Sekunden) wartet er einmal ab.
- Claude bekommt die Anweisung, große Seiten statt vieler kleiner abzufragen, `get_item` sparsam zu nutzen und nichts parallel zu schicken.

Umgangen wird der Bot-Schutz nicht, also keine wechselnden IPs, Proxys oder Browser-Imitation. Die Nutzungsbedingungen von Vinted untersagen automatisierte Abfragen. Gedacht ist der Connector für gelegentliche private Suchen, nicht als Dauer-Suchbot.

Die Seiten werden per HTML geparst. Baut Vinted das Layout um, fehlen zuerst Marke und Zustand, im schlimmsten Fall kommen keine Treffer mehr.

## Lokal entwickeln

```sh
npm install
echo 'CONNECTOR_SECRET=local-dev-secret-0123456789abcdef' > .dev.vars
npm run dev
```

MCP-Endpunkt dann unter `http://localhost:8787/local-dev-secret-0123456789abcdef/mcp`.
