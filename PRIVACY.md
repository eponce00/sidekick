# Privacy

Last updated: July 22, 2026

SideKick is a local-first desktop application. It does not require a SideKick account and does not
send application data through a SideKick-operated backend. The app does not include analytics,
advertising, behavioral tracking, or automatic remote crash reporting.

Local-first does not mean that every feature is offline. SideKick sends data directly to services
you choose when a feature needs them. This document describes those boundaries so you can make an
informed choice before connecting a provider or granting an agent broader permissions.

## Data stored on your device

SideKick keeps the following data in the operating system's application-data directory:

- conversations, messages, projects, group chats, plans, goals, run state, permission records, and
  workspace memory in a local SQLite database;
- application preferences and provider or connector configuration;
- SideKick History snapshots for changes made through SideKick;
- command output retained for durable runs, plus local operational and update logs; and
- encrypted provider and connector credentials.

Provider and connector secrets are encrypted with Electron `safeStorage` when the operating
system's credential service is available. Decrypted credentials remain in the trusted main process
and are not returned to normal renderer state. SideKick does not claim to protect local data from a
person or process that already controls your operating-system account.

Project folders remain where you selected them. SideKick can read or change project files only
through its workspace tools and the active permission policy. SideKick History is separate from the
project and does not alter its Git history.

## Data sent to services you choose

### Model providers

When you use a local server or hosted model provider, SideKick sends the selected provider the data
needed for that request. Depending on the task, that can include your prompt, conversation context,
manual location, attached images, relevant project instructions or file content, tool definitions,
and tool results. Hosted providers process that data under their own terms and privacy policies.
Local model servers receive requests on the endpoint you configured.

SideKick does not proxy provider traffic. Provider credentials and requests travel directly from
the trusted main process to the configured provider endpoint.

### Search, pages, images, and maps

Built-in web search sends the search text directly to public DuckDuckGo, Brave Search, and Bing
surfaces. Opening or reading a result contacts the result site's server. Image search and retrieval
can contact DuckDuckGo and the selected image host. Interactive or linked map content can contact
the map provider shown in the interface. These services receive ordinary network information such
as your IP address and may apply their own cookies, logging, and privacy policies.

SideKick has no search relay and does not receive a copy of these requests.

### MCP connectors and local processes

An enabled MCP connector can receive tool arguments and other context required for a tool call, and
can read or change data in the connected service according to the account permissions you grant.
Remote connectors communicate directly with the configured server. Local `stdio` connectors run as
processes under your operating-system account and receive their input locally.

OAuth access and refresh tokens are kept in protected main-process storage. SideKick cannot reduce
the permissions granted by the connected service, so review the service's authorization screen and
disconnect connectors you no longer use.

### Updates and operating-system services

Installed builds contact the public GitHub Releases feed to check for, download, and install
updates. No GitHub account or bundled GitHub token is used. If notifications are enabled, SideKick
uses the operating system's notification service. Clipboard operations occur only after an
explicit copy action.

## Retention and deletion

Conversations and groups remain on the device until you delete them in SideKick or remove the local
application data. Removing a project from SideKick removes its app association; it does not delete
the project folder. Uninstalling the application may leave its application-data directory in place
so a reinstall can preserve settings and conversations.

To remove all SideKick data, quit the app first and delete its application-data directory:

- macOS: `~/Library/Application Support/SideKick`
- Windows: `%APPDATA%\SideKick`

Deleting this directory permanently removes conversations, settings, local logs, encrypted
credentials, and SideKick History from that operating-system account. It does not delete files in
project folders or data already sent to a third-party provider or connector. Use the third party's
controls for that data.

## Diagnostics and support

The in-app diagnostics export is intentionally metadata-only. It excludes prompts, messages,
project paths, filenames, file content, provider or connector endpoints, model names, tool input and
output, and credentials. Review any exported file before sharing it. Bug reports and screenshots
can still contain personal information; redact them before posting publicly.

## Security and changes

Commands, connectors, and other privileged actions run with the logged-in user's operating-system
permissions. SideKick is not an operating-system sandbox. Read the
[permission policy](docs/user-guide/PERMISSIONS.md) before enabling broad autonomy.

Report suspected vulnerabilities through the private process in the
[security policy](SECURITY.md). Material changes to SideKick's data handling will be reflected in
this document and the [changelog](CHANGELOG.md).
