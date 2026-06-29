# Automat​ Agentic Call Quality Intelligence​

> An agentic, human-in-the-loop pipeline that transcribes call center recordings, scores agent performance, classifies Quality of Service, and analyzes customer sentiment — fully orchestrated end-to-end in UiPath Maestro.

---

## 1. Business Problem

Call centers generate thousands of recorded customer interactions every week, but most quality assurance (QA) teams can only manually review a small, random sample of them. This creates three problems:

- **Coverage gap** — the vast majority of calls are never reviewed, so coaching and compliance issues go undetected.
- **Inconsistency** — manual scoring varies reviewer to reviewer, making QA scores unreliable for performance management.
- **Slow feedback loops** — by the time a human reviewer flags an issue, days or weeks may have passed.

**Agentic Call Quality Intelligence​** solves this by automatically transcribing every call, running it through a set of grounded AI agents that score quality, classify service level, and analyze sentiment, and routing only the ambiguous cases to a human reviewer — turning QA from a manual sampling exercise into a continuous, fully auditable pipeline.

---

## 2. How It Works (Architecture)

The pipeline is modeled and orchestrated as a single BPMN process in **UiPath Maestro**: `Speech Transcript Quality Evaluation Process`. The diagram below covers the **UiPath-native portion of the system, start to end** — everything from the trigger through to the Data Fabric write. What happens after that (the dashboard and Claude integration) is a separate, custom layer described in 2.2.

```
┌────────────────────────────────────────────────────────────────────┐
│ START EVENT                                                        │
│ Google Drive: "File Created" (CallRecordings_Inbox)                │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│ RPA WORKFLOW                                                       │
│ - Upload audio to Azure Blob Storage                               │
│ - Azure AI Speech (batch transcription + diarization)      │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│ AI AGENT                                                           │
│ SpeechTranscriptRefiner Agent                                      │
│ - Clean & Structure transcript                                     │
│ - Identify Call Center Agent                                       │
│ - Normalize speaker turns                                          │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│ GATEWAY: HUMAN REVIEW REQUIRED?                                    │
└────────────────────────────────────────────────────────────────────┘
              │ YES                                      │ NO
              ▼                                          ▼
┌──────────────────────────────┐            ┌──────────────────────────────┐
│ UiPath APP TASK              │            │ AUTO APPROVED                │
│ Human Review Transcripts     │            │ Skip manual validation       │
└──────────────────────────────┘            └──────────────────────────────┘
              │                                          │
              └──────────────────────┬───────────────────┘
                                     ▼
                         ┌────────────────────────┐
                         │ MERGE REVIEW OUTPUT    │
                         └────────────────────────┘
                                     │
                                     ▼
                     ┌──────────────────────────────────┐
                     │ PARALLEL ANALYTICS GATEWAY       │
                     └──────────────────────────────────┘
                        │            │             │
                        ▼            ▼             ▼
        ┌────────────────────┐ ┌────────────────┐ ┌────────────────────┐
        │ QA Scoring Agent   │ │ QoS Agent      │ │ Sentiment Agent    │
        │ - Quality scoring  │ │ - Service QoS  │ │ - Emotion analysis │
        └────────────────────┘ └────────────────┘ └────────────────────┘
                        │            │             │
                        └────────────┬─────────────┘
                                     ▼
                     ┌──────────────────────────────────┐
                     │ PARALLEL JOIN / CONSOLIDATION    │
                     └──────────────────────────────────┘
                                     │
                                     ▼
                     ┌──────────────────────────────────┐
                     │ Data Fabric Record Builder Agent │
                     │ - Persist QA + QoS + Sentiment   │
                     │ - Upload TranscriptQAResult      │
                     │ - Upload TranscriptQADashboard   │
                     └──────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│ END EVENT                                                          │
└────────────────────────────────────────────────────────────────────┘
```

**Flow explanation:**

1. **Trigger (Start Event)** — A Google Drive "File Created" event watching the `CallRecordings_Inbox` folder, via a connected Google account. When a new call recording lands in that folder, a new process instance starts.
2. **AzureSpeech_Transcription (RPA workflow)** — sends the audio file's Drive link to Azure AI Speech (batch transcription, speaker diarization) and returns the raw transcript text and a reference Drive link.
3. **SpeechTranscriptRefiner Agent** — cleans up the raw transcript and resolves which call center agent the recording belongs to.
4. **Human Review Required? (gateway)** — a confidence-threshold check on the refiner agent's output decides whether the transcript needs human eyes.
   - **Needs Human Review** → routed to the **Human Review Transcripts** App as a user task; a human reviewer corrects/approves the transcript.
   - **Auto-Approved** → skips straight to the merge step.
5. **Merge Review** — both paths converge back into a single reviewed transcript.
6. **Parallel Split Gateway** — the reviewed transcript is fanned out to three agents simultaneously:
   - **QA Scoring Agent** — scores the agent's call performance against a rubric.
   - **QoS Agent (QoS Classification Agent)** — classifies the interaction's service quality category.
   - **Sentiment Agent (Sentiment Analysis Agent)** — analyzes customer sentiment throughout the call.
7. **Parallel Join Gateway** — waits for all three agents to finish.
8. **Data Fabric Record Builder Agent** — consolidates the three outputs into a single structured record and writes it to UiPath Data Fabric.
9. **End Event** — process completes; the record is now queryable for reporting/dashboarding.

### 2.1 Step-by-Step Breakdown

A quick overview of what each node does. Exact variable names and bindings are already documented inside the `.uis` package itself, so this table sticks to purpose-level detail plus the **Storage Bucket → Context Grounding Index → Data Fabric Entity** each step is grounded on or writes to.

| # | Node | Type | What it does | NOTE |
|---|---|---|---|---|
| 1 | Start Event | File Create start event | Triggered by a Google Drive "File Created" event, watching the `CallRecordings_Inbox` folder via a connected Google account. | N/A — trigger only |
| 2 | AzureSpeech_Transcription | Service task (RPA workflow) | Uploads the recording to Azure Blob Storage, then sends it to Azure AI Speech for batch transcription and returns the raw transcript text. | N/A (uses Orchestrator Assets — see Section 6.3) |
| 3 | SpeechTranscriptRefiner Agent | Service task (agent) | Takes the raw transcript text as input, cleans it up, and identifies which call center agent the recording belongs to. | Index `CallCenter Agent Master`, built from the `CallCenterAgentList` entity |
| 4 | App task for human review | User task | If confidence is low, routes the refined transcript text to the **Human Review Transcripts** app for a human reviewer to correct/approve. | N/A |
| 5 | QA Scoring Agent | Service task (agent) | Takes the refined transcript text as input and scores the call against a QA rubric. | Storage Bucket `Call Center Agent Scoring Evaluation Criteria` → Index `Call Center Agent Scoring Evaluation Criteria` |
| 6 | QoS Agent | Service task (agent) | Takes the refined transcript text as input and classifies the interaction's service quality / issue type. | Storage Bucket `DOCUMENT_QoS_Classification` → Index `DOCUMENT_QoS_Classification` |
| 7 | Sentiment Agent | Service task (agent) | Takes the refined transcript text as input and analyzes customer sentiment throughout the call. | Storage Bucket `DOCUMENT_Sentiment_Score_Analysis` → Index `DOCUMENT_Sentiment_Score_Analysis` |
| 7 | Data Fabric Record Builder Agent | Service task (agent) | Consolidates the QA, QoS, and Sentiment results into a single record and adds it to UiPath Data Fabric **via Data Fabric Activities** (not a bound Solution resource — this is why it won't appear in the Resources/Entities panel of the imported Solution). | Entities `TranscriptQAResult` and `TranscriptQADashboard` (tenant: `DefaultTenant`) |
---

### 2.2 Insight Layer via UiPath Autopilot for Everyone

In addition to the web dashboard, users can interact with the QA data using **UiPath Autopilot for Everyone** through the **`Retrieve Transcript QA Dashboard`** RPA workflow.

The workflow retrieves the latest QA records from **UiPath Data Fabric** and provides them to Autopilot as structured context. Users can then ask natural language questions, and Autopilot analyzes the data, identifies trends and relationships, and generates visualizations without requiring users to manually navigate the dashboard.

```
UiPath Data Fabric
(TranscriptQADashboard)
            │
            ▼
Retrieve Transcript QA Dashboard (RPA)
            │
            ▼
UiPath Autopilot for Everyone
            │
      ┌─────┴─────┐
      ▼           ▼
Natural Language  Visualizations
Analysis          & Charts
```

**Example capabilities:**

* Ask questions using natural language instead of navigating the dashboard.
* Compare QA performance across agents.
* Identify relationships between **QA Score**, **QoS Classification**, and **Customer Sentiment**.
* Detect trends, recurring issues, and performance outliers.
* Automatically generate charts and visual summaries from the retrieved data.
* Explore insights beyond predefined dashboard widgets.

```
This complements the browser dashboard by providing an AI-driven experience for ad hoc analysis, allowing users to discover insights and relationships that are not available through fixed dashboard views.
```
---

### 2.3 Insight Layer (Outside UiPath)

Everything above runs natively inside UiPath. Once the Data Fabric Record Builder Agent writes a record, a separate custom layer takes over to turn that data into something people (and Claude) can actually use:

```
UiPath Data Fabric
(TranscriptQADashboard)
                │
                ▼  via Data Fabric API
UiPath-DataFabric-API-Dashboard-Web
        (custom MCP server)
                │
        ┌───────┴────────┐
        ▼                ▼
  Analytics Dashboard   Claude Insight Assistant
  (browser, human       (MCP connector via ngrok,
   reviewers)            see Section 6.6)
```

- **UiPath-DataFabric-API-Dashboard-Web** — the custom Node.js/Express MCP server in this repo. It queries the `TranscriptQADashboard` entities via the Data Fabric API.
- **Analytics Dashboard** — a browser-based view of the same data for human reviewers/managers (served by the same app).
- **Claude Insight Assistant** — the MCP server is exposed publicly via ngrok and added to Claude as a custom connector (Section 6.6), so Claude can be asked questions about the QA data directly — e.g. trends, outliers, agent-level summaries — without anyone needing to open the dashboard.

This layer is original solution code, not a UiPath product feature — see the licensing note below.

---



## 3. UiPath Components Used
| Component                                     | Role in this solution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maestro (BPMN Orchestration)**              | Orchestrates the full `Speech Transcript Quality Evaluation Process` — conditional human-review branch, parallel agent fan-out/fan-in, and final consolidation.                                                                                                                                                                                                                                                                                                                                                                         |
| **Agent Builder (Low-Code Agents)**           | `SpeechTranscriptRefiner Agent`, `QA Scoring Agent`, `QoS Classification Agent`, `Sentiment Analysis Agent`, `Data Fabric Record Builder Agent`.                                                                                                                                                                                                                                                                                                                                                                                        |
| **RPA Workflows**                             | `AzureSpeech_Transcription` — uploads the recording to Azure Blob Storage, then calls Azure AI Speech for batch transcription with speaker diarization. <br><br>`Retrieve Transcript QA Dashboard` — retrieves `TranscriptQADashboard` records from UiPath Data Fabric and provides them to UiPath Autopilot for Everyone for natural language analysis, insight generation, and automatic visualizations.                                                                                                                              |
| **UiPath Apps**                               | `Human Review Transcripts` — the human-in-the-loop UI surfaced as a Maestro user task.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **UiPath Data Fabric (Data Service)**         | `CallCenterAgentList` entity — agent roster, bound as a Solution resource and indexed into `CallCenter Agent Master` for grounding; `TranscriptQAResult` and `TranscriptQADashboard` entities (tenant: `DefaultTenant`) — written via Data Fabric Activities by the Data Fabric Record Builder Agent. The reporting dashboard reads the same entities externally via the Data Fabric API, authenticated through an **External Application** registered in UiPath Admin (Identity → External Applications), not a Studio Web Connection. |
| **Context Grounding (Indexes)**               | `CallCenter Agent Master`, `Call Center Agent Scoring Evaluation Criteria`, `DOCUMENT_QoS_Classification`, `DOCUMENT_Sentiment_Score_Analysis` — RAG grounding sources used by the SpeechTranscriptRefiner, QA, QoS, and Sentiment agents.                                                                                                                                                                                                                                                                                              |
| **Orchestrator Storage Buckets**              | `Call Center Agent Scoring Evaluation Criteria`, `DOCUMENT_QoS_Classification`, `DOCUMENT_Sentiment_Score_Analysis` — source documents backing the indexes above.                                                                                                                                                                                                                                                                                                                                                                       |
| **Connections**                               | Google Drive connection — process trigger, "File Created" event on the `CallRecordings_Inbox` folder; Automat Consult External Application (Data Fabric API access — see Data Fabric row below).                                                                                                                                                                                                                                                                                                                                        |
| **Orchestrator Assets**                       | `AzureBlobBaseUrl` (Text), `AzureBlobSasToken` (Secret), `Ocp-Apim-Subscription-Key` (Secret), `SpeechEndpoint` (Text) — credentials/config used by the `AzureSpeech_Transcription` RPA workflow to upload recordings to Azure Blob Storage and call Azure AI Speech.                                                                                                                                                                                                                                                                   |
| **UiPath Autopilot for Everyone (Assistant)** | Provides conversational, natural-language access layer over the `TranscriptQADashboard` and related Data Fabric entities. Enables users to ask ad-hoc questions (e.g., QA score trends, sentiment vs QoS correlations, agent comparisons), generate insights, and produce automatic summaries and visualizations without needing predefined dashboard views or workflows.                                                                                                                                                               |



### Supporting custom integration

This repo also includes `UiPath-DataFabric-API-Dashboard-Web/`, a custom Node.js/Express **MCP (Model Context Protocol) server** built for this project. It connects to UiPath Data Fabric and serves the `CallCenterAgentList` QA data to both a browser dashboard and to Claude for analysis — this is original solution code, not a UiPath component, and is licensed separately under this repo's open-source license.

---

## 4. Agent Type

**This solution uses Low-Code Agents**, built with UiPath Agent Builder and orchestrated through Maestro:

- `SpeechTranscriptRefiner Agent`
- `QA Scoring Agent`
- `QoS Classification Agent`
- `Sentiment Analysis Agent`
- `Data Fabric Record Builder Agent`

---

## 5. Repository Structure

```
UipathAgentHack2026/
├── LICENSE
├── README.md                                 ← this file (covers description, components, agent type, setup)
├── SpeechQA-Analytics-Intelligence-Suite-AgenticProcess/
│   ├── AgentHack_SpeechQA_Analytics_Intelligence_Suite.uis
├── UiPath-DataFabric-API-Dashboard-Web/      ← custom MCP server (Data Fabric ↔dashboard ↔ AI Connector (Claude))
│   ├── .env.example
│   └── README.md
├── storage-bucket-docs/
│   ├── Call Center Agent Scoring Evaluation Criteria.pdf    
│   ├── DOCUMENT_QoS_Classification.pdf                      
│   └── DOCUMENT_Sentiment_Score_Analysis.pdf                
├── data-fabric-schema-data/
│   ├── data-fabric.schema.json
    ├── CallCenterAgentList-data.csv
│   ├── TranscriptQAResult-data.csv
│   └── TranscriptQADashboard-data.csv
└── sample-wav-recording-data/
    ├── AnnaWilson_062420262002.wav
    ├── sample-wav-recording1.wav 
    ├── sample-wav-recording2.wav
    ├── sample-wav-recording3.wav
    └── sample-wav-recording4.wav       
```

---

## 6. Setup Instructions

### 6.1 Prerequisites

- A UiPath Automation Cloud tenant with: Orchestrator, Data Service, Maestro, Studio Web, Agent Builder, and Autopilot for Everyone enabled.
- An Azure subscription with Azure AI Speech (batch transcription) enabled.
- Node.js 18+ (for the optional MCP dashboard server).
- A Google account with a `CallRecordings_Inbox` folder created in Google Drive (this is the folder the trigger watches).

### 6.2 Import the solution

1. In Studio Web, go to **Solutions** → **Import** and select `SpeechQA-Analytics-Intelligence-Suite-AgenticProcess/AgentHack_SpeechQA_Analytics_Intelligence_Suite.uis`.
2. UiPath will show the imported Processes and flag unresolved resource references — this is expected. Continue to step 6.3 before running anything.

### 6.3 Recreate environment-specific resources

Storage Buckets, Indexes, Connections, and Data Fabric Entities are tenant-scoped and are **not** included in the `.uis` package. Recreate them in your tenant as follows:

| Resource | Type | Name | Recreate steps |
|---|---|---|---|
| Connection | Connection | Google Drive | Connections → Add → Google Drive → authenticate with your own Google account, then create a `CallRecordings_Inbox` folder in Google Drive |
| Asset | Orchestrator Asset (Text) | `AzureBlobBaseUrl` | Orchestrator → Assets → Add → Text → set to your Azure Blob Storage container base URL |
| Asset | Orchestrator Asset (Secret) | `AzureBlobSasToken` | Orchestrator → Assets → Add → Secret → set to your Azure Blob Storage SAS token |
| Asset | Orchestrator Asset (Secret) | `Ocp-Apim-Subscription-Key` | Orchestrator → Assets → Add → Secret → set to your Azure AI Speech subscription key |
| Asset | Orchestrator Asset (Text) | `SpeechEndpoint` | Orchestrator → Assets → Add → Text → set to your Azure AI Speech endpoint URL |
| Entity | Data Fabric | `CallCenterAgentList` | Data Fabric → Entities → Import → use `data-fabric-schema-data/CallCenterAgentList.schema.json` |
| Entity | Data Fabric | `TranscriptQAResult` (tenant: `DefaultTenant`) | Data Fabric → Entities → Add → create with matching fields (written to via Data Fabric Activities by the Data Fabric Record Builder Agent — not a Solution-bound resource) |
| Entity | Data Fabric | `TranscriptQADashboard` (tenant: `DefaultTenant`) | Data Fabric → Entities → Add → create with matching fields (read by the reporting dashboard / MCP server) |
| Storage Bucket | Bucket | `Call Center Agent Scoring Evaluation Criteria` | Orchestrator → Storage Buckets → Add → name exactly as shown, upload reference docs |
| Storage Bucket | Bucket | `DOCUMENT_QoS_Classification` |  Orchestrator → Storage Buckets → Add → name exactly as shown, upload reference docs |
| Storage Bucket | Bucket | `DOCUMENT_Sentiment_Score_Analysis` | Orchestrator → Storage Buckets → Add → name exactly as shown, upload reference docs |
| Index | Context Grounding | `CallCenter Agent Master` | Studio Web → Indexes → Create → point at corresponding bucket above |
| Index | Context Grounding | `Call Center Agent Scoring Evaluation Criteria` | Same, source = matching bucket |
| Index | Context Grounding | `DOCUMENT_QoS_Classification` | Same, source = matching bucket |
| Index | Context Grounding | `DOCUMENT_Sentiment_Score_Analysis` | Same, source = matching bucket |
| External Application | UiPath Admin | Automat Consult (Data Fabric API access) | UiPath Admin → Identity → External Applications → Add → register an app, grant Data Fabric API scope, then use the generated Client ID/Secret in `UiPath-DataFabric-API-Dashboard-Web/.env` |



### 6.4 Run the demo

1. In Maestro, deploy `Speech Transcript Quality Evaluation Process`.
2. Use the sample recording at `sample-data/sample_call_recording.wav` (placeholder — replace with your own test recording once uploaded), or upload any `.wav` recording into the `CallRecordings_Inbox` folder in your connected Google Drive — the trigger will pick it up automatically.
3. Watch the process move through transcription → (optional human review) → parallel scoring → Data Fabric write.
4. Open the dashboard 

### 6.5 Analytics Interfaces (Optional choice)

After deploying the solution, users can choose how they want to interact with the analytics and insights layer. The solution supports multiple access modes depending on the level of detail and technical depth required.

| Option | Description | Setup Required |
|--------|-------------|----------------|
| **UiPath Autopilot for Everyone (Assistant)** | Natural language interface over `TranscriptQADashboard` and `TranscriptQAResult`. Enables users to ask business questions such as QA trends, agent comparisons, sentiment analysis, and QoS correlations. | ❌ No additional setup |
| **MCP Dashboard Server (Node.js)** | Developer-focused dashboard and API layer that enables external AI tools (e.g., Claude) to query and analyze QA data via MCP. | ⚠️ Requires local Node.js + ngrok setup |
---

#### 6.5.1 UiPath Autopilot for Everyone

UiPath Autopilot for Everyone is automatically available once the following conditions are met:

- Data Fabric entities are created:
  - `TranscriptQAResult`
  - `TranscriptQADashboard`
- The `Speech Transcript Quality Evaluation Process` has executed at least once and generated data

---

#### How to Access

Users can open Autopilot from:

- UiPath Assistant → **Autopilot for Everyone**
- Or directly within the UiPath Automation Cloud experience (if enabled for tenant)

---

#### Configuration Requirement (Admin Setup)

Before use, Autopilot for Everyone must be enabled in:

1. Go to **UiPath Automation Cloud**
2. Navigate to **Admin**
3. Select **Tenant**
4. Open **AI Trust Layer**
5. Select **Autopilot for Everyone**
6. Go to the **Tools** tab
7. Click **Configure Tools**
8. Select:
   - `Speech Transcript Quality Evaluation Process`
9.  Save and publish configuration

---

#### What You Can Ask

Users can interact with the system using natural language queries such as:

- "Show me QA score trends for this week"
- "Compare agent performance by sentiment score"
- "What is the relationship between QoS and QA score?"
- "Which agents have the lowest sentiment ratings?"
- "Summarize today's transcript quality results"

---

#### System Behavior

Once configured, Autopilot for Everyone will automatically:

- Query Data Fabric entities (`TranscriptQAResult`, `TranscriptQADashboard`)
- Perform contextual analysis across QA, QoS, and Sentiment dimensions
- Generate insights and summaries in natural language
- Provide optional visual trends and comparisons
- Enable ad-hoc exploration without predefined dashboards

#### 6.5.2 Connect the Dashboard to Claude (MCP via ngrok)

The custom MCP server in `UiPath-DataFabric-API-Dashboard-Web/`  can be exposed to Claude as a connector, so Claude can query and discuss your QA data directly instead of just the browser dashboard.

   Full configuration details are available in:
   ```bash
   UiPath-DataFabric-API-Dashboard-Web/README.md
   ```
1. Make sure the local server is running first :
   ```bash
   cd UiPath-DataFabric-API-Dashboard-Web
   cp .env.example .env     # fill in your Data Fabric tenant URL + credentials
   npm install
   npm start
   ```
   By default it listens on port `3000`.

2. Authenticate ngrok (first-time setup only):
   ```bash
   ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
   ```

3. Open a public tunnel to your local server:
   ```bash
   ngrok http 3000
   ```

4. Copy the HTTPS URL ngrok prints out (e.g. `https://your-subdomain.ngrok-free.dev`), and append your server's MCP endpoint path (e.g. `/mcp`).

5. In Claude, go to **Settings → Connectors → Add custom connector**, and paste that full URL.

6. Click **Connect**.

> ⚠️ Free ngrok URLs are temporary — restarting the tunnel generates a new URL (unless you reserve a static domain on a paid ngrok plan), so you'll need to update the connector URL in Claude each time. If Claude shows "Couldn't connect to the server," double-check that both `npm start` and `ngrok http 3000` are still running in the background, and that the URL in Claude's connector settings matches the current ngrok URL exactly.


---

## 7. License

This repository is licensed under the [Apache License 2.0](./LICENSE) for all original solution code (Maestro process definitions, agent configurations, the MCP server, and documentation).

This license does **not** extend to UiPath proprietary tools, activities, SDK packages, or platform components referenced or used within the solution (Maestro, Agent Builder, Data Fabric, Orchestrator, Azure AI Speech, Autopilot for Everyone, Action Center, UiPath Apps, etc.), which remain subject to their own license terms.

---

## Team

- Sorasak Leelapornudom​ — RPA & AI Technical Lead 
- Worathep Winyattikul — Automation Developer
- Chinnawat Cantanet​ — Automation Developer
- Pimolmas Yanisarapan​​ — Business Analyst 