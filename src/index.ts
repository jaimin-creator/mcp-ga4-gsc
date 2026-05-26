import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { refreshAccessToken, type Props } from "./utils";

function asTextResult(payload: unknown) {
	return {
		content: [{ text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), type: "text" as const }],
	};
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Rablab GA4 + Search Console MCP",
		version: "1.0.0",
	});

	// In-memory cache of the refreshed token for this DO instance.
	private cachedAccessToken: string | null = null;
	private cachedExpiresAt = 0;

	/**
	 * Return a valid Google access_token, refreshing it transparently using the
	 * refresh_token stored in props if the current one is expired.
	 */
	private async getValidAccessToken(forceRefresh = false): Promise<string> {
		const props = this.props as Props;
		const now = Date.now();
		if (!forceRefresh) {
			if (this.cachedAccessToken && this.cachedExpiresAt > now) {
				return this.cachedAccessToken;
			}
			if (props.accessToken && props.tokenExpiresAt > now) {
				this.cachedAccessToken = props.accessToken;
				this.cachedExpiresAt = props.tokenExpiresAt;
				return props.accessToken;
			}
		}
		if (!props.refreshToken) {
			throw new Error("Access token expired and no refresh_token available. Please reconnect this MCP.");
		}
		const refreshed = await refreshAccessToken({
			clientId: this.env.GOOGLE_CLIENT_ID,
			clientSecret: this.env.GOOGLE_CLIENT_SECRET,
			refreshToken: props.refreshToken,
		});
		if (!refreshed) {
			throw new Error("Failed to refresh Google access token. Please reconnect this MCP.");
		}
		this.cachedAccessToken = refreshed.access_token;
		this.cachedExpiresAt = now + (refreshed.expires_in - 60) * 1000;
		return refreshed.access_token;
	}

	/**
	 * Authed Google API fetch, transparently refreshing the token on 401.
	 */
	private async callGoogle(url: string, init: RequestInit = {}): Promise<unknown> {
		const doFetch = async (token: string) => {
			const resp = await fetch(url, {
				...init,
				headers: {
					...(init.headers || {}),
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			});
			const text = await resp.text();
			let data: unknown;
			try { data = JSON.parse(text); } catch { data = text; }
			return { resp, data };
		};
		let token = await this.getValidAccessToken();
		let { resp, data } = await doFetch(token);
		if (resp.status === 401) {
			token = await this.getValidAccessToken(true); // force refresh + retry once
			({ resp, data } = await doFetch(token));
		}
		if (!resp.ok) {
			throw new Error(`Google API ${resp.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
		}
		return data;
	}

	async init() {
		// =========================
		// Google Analytics 4 tools
		// =========================

		this.server.tool(
			"ga4_list_account_summaries",
			"List all Google Analytics 4 accounts and properties accessible to the authenticated user. Use this to discover property IDs needed for run_report.",
			{},
			async () => {
				const data = await this.callGoogle("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200");
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_get_property_details",
			"Get details about a specific GA4 property (timezone, currency, industry, etc.).",
			{ property_id: z.string().describe("GA4 property ID, e.g. 123456789 or properties/123456789") },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_run_report",
			"Run a Google Analytics 4 report. Returns metrics broken down by dimensions for a date range. Common dimensions: date, country, deviceCategory, sessionDefaultChannelGroup, pagePath, landingPage. Common metrics: sessions, totalUsers, newUsers, screenPageViews, conversions, totalRevenue, engagementRate, averageSessionDuration.",
			{
				property_id: z.string().describe("GA4 property ID"),
				start_date: z.string().describe("YYYY-MM-DD or relative like 7daysAgo, 30daysAgo, yesterday"),
				end_date: z.string().describe("YYYY-MM-DD or relative like today, yesterday"),
				dimensions: z.array(z.string()).optional().describe("List of dimension names"),
				metrics: z.array(z.string()).describe("List of metric names, at least one required"),
				dimension_filter: z.string().optional().describe("Optional JSON string with FilterExpression"),
				limit: z.number().optional().default(100).describe("Max rows, default 100, max 100000"),
			},
			async ({ property_id, start_date, end_date, dimensions, metrics, dimension_filter, limit }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const body: Record<string, unknown> = {
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					metrics: metrics.map((m) => ({ name: m })),
					limit: String(limit ?? 100),
				};
				if (dimensions && dimensions.length) body.dimensions = dimensions.map((d) => ({ name: d }));
				if (dimension_filter) {
					try { body.dimensionFilter = JSON.parse(dimension_filter); } catch { /* ignore */ }
				}
				const data = await this.callGoogle(`https://analyticsdata.googleapis.com/v1beta/${pid}:runReport`, { method: "POST", body: JSON.stringify(body) },
				);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_run_realtime_report",
			"Run a Google Analytics 4 realtime report. Returns active users data from the last 30 minutes.",
			{
				property_id: z.string().describe("GA4 property ID"),
				dimensions: z.array(z.string()).optional(),
				metrics: z.array(z.string()).describe("Realtime metrics, e.g. activeUsers, screenPageViews"),
			},
			async ({ property_id, dimensions, metrics }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const body: Record<string, unknown> = { metrics: metrics.map((m) => ({ name: m })) };
				if (dimensions && dimensions.length) body.dimensions = dimensions.map((d) => ({ name: d }));
				const data = await this.callGoogle(`https://analyticsdata.googleapis.com/v1beta/${pid}:runRealtimeReport`, { method: "POST", body: JSON.stringify(body) },
				);
				return asTextResult(data);
			},
		);

		// =========================
		// Google Search Console tools
		// =========================

		this.server.tool(
			"gsc_list_sites",
			"List all Search Console properties accessible to the authenticated user.",
			{},
			async () => {
				const data = await this.callGoogle("https://www.googleapis.com/webmasters/v3/sites");
				return asTextResult(data);
			},
		);

		this.server.tool(
			"gsc_query_search_analytics",
			"Query Search Console search analytics. Returns clicks, impressions, CTR, position for the given site, date range, and dimensions. Common dimensions: query, page, country, device, date, searchAppearance.",
			{
				site_url: z.string().describe("Site URL, e.g. https://www.example.com/ or sc-domain:example.com"),
				start_date: z.string().describe("YYYY-MM-DD"),
				end_date: z.string().describe("YYYY-MM-DD"),
				dimensions: z.array(z.string()).optional().describe("Dimensions list"),
				row_limit: z.number().optional().default(1000),
				dimension_filter_groups: z.string().optional().describe("Optional JSON array of dimensionFilterGroups"),
			},
			async ({ site_url, start_date, end_date, dimensions, row_limit, dimension_filter_groups }) => {
				const body: Record<string, unknown> = {
					startDate: start_date,
					endDate: end_date,
					rowLimit: row_limit ?? 1000,
				};
				if (dimensions && dimensions.length) body.dimensions = dimensions;
				if (dimension_filter_groups) {
					try { body.dimensionFilterGroups = JSON.parse(dimension_filter_groups); } catch { /* ignore */ }
				}
				const encoded = encodeURIComponent(site_url);
				const data = await this.callGoogle(`https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`, { method: "POST", body: JSON.stringify(body) },
				);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"gsc_list_sitemaps",
			"List sitemaps submitted to Search Console for a given site.",
			{ site_url: z.string().describe("Site URL or sc-domain:") },
			async ({ site_url }) => {
				const encoded = encodeURIComponent(site_url);
				const data = await this.callGoogle(`https://www.googleapis.com/webmasters/v3/sites/${encoded}/sitemaps`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"gsc_inspect_url",
			"Inspect a specific URL in Search Console (indexation status, last crawl, mobile usability, etc.). Powered by Google's URL Inspection API.",
			{
				site_url: z.string().describe("Owned site URL or sc-domain:"),
				inspection_url: z.string().describe("Full URL to inspect"),
				language_code: z.string().optional().default("en-CA"),
			},
			async ({ site_url, inspection_url, language_code }) => {
				const body = {
					inspectionUrl: inspection_url,
					siteUrl: site_url,
					languageCode: language_code ?? "en-CA",
				};
				const data = await this.callGoogle("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { method: "POST", body: JSON.stringify(body) },
				);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"gsc_get_sitemap",
			"Get details of a specific sitemap submitted to Search Console (status, last submitted, last downloaded, warnings, errors, contents).",
			{
				site_url: z.string().describe("Owned site URL or sc-domain:"),
				feedpath: z.string().describe("Full URL of the sitemap, e.g. https://example.com/sitemap.xml"),
			},
			async ({ site_url, feedpath }) => {
				const encodedSite = encodeURIComponent(site_url);
				const encodedFeed = encodeURIComponent(feedpath);
				const data = await this.callGoogle(`https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedFeed}`);
				return asTextResult(data);
			},
		);

		// =========================
		// GA4 Data API additionnels
		// =========================

		this.server.tool(
			"ga4_get_metadata",
			"List all dimensions and metrics available for a specific GA4 property (including custom dimensions/metrics). Use this to discover what you can query in run_report.",
			{ property_id: z.string().describe("GA4 property ID, e.g. 123456789") },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsdata.googleapis.com/v1beta/${pid}/metadata`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_check_compatibility",
			"Check which dimensions and metrics are compatible with a given report configuration. Useful for diagnosing why a runReport returns errors.",
			{
				property_id: z.string(),
				dimensions: z.array(z.string()).optional(),
				metrics: z.array(z.string()).optional(),
				compatibility_filter: z.string().optional().describe("COMPATIBLE or INCOMPATIBLE (default COMPATIBLE)"),
			},
			async ({ property_id, dimensions, metrics, compatibility_filter }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const body: Record<string, unknown> = { compatibilityFilter: compatibility_filter || "COMPATIBLE" };
				if (dimensions && dimensions.length) body.dimensions = dimensions.map((d) => ({ name: d }));
				if (metrics && metrics.length) body.metrics = metrics.map((m) => ({ name: m }));
				const data = await this.callGoogle(`https://analyticsdata.googleapis.com/v1beta/${pid}:checkCompatibility`, { method: "POST", body: JSON.stringify(body) },
				);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_run_pivot_report",
			"Run a GA4 pivot report (pivot tables with multiple pivots). Returns metrics aggregated by pivot dimensions.",
			{
				property_id: z.string(),
				start_date: z.string(),
				end_date: z.string(),
				dimensions: z.array(z.string()),
				metrics: z.array(z.string()),
				pivots: z.string().describe("JSON string of pivots array, e.g. '[{\"fieldNames\":[\"country\"],\"limit\":10}]'"),
			},
			async ({ property_id, start_date, end_date, dimensions, metrics, pivots }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				let parsedPivots: unknown = [];
				try { parsedPivots = JSON.parse(pivots); } catch { /* ignore */ }
				const body = {
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: dimensions.map((d) => ({ name: d })),
					metrics: metrics.map((m) => ({ name: m })),
					pivots: parsedPivots,
				};
				const data = await this.callGoogle(`https://analyticsdata.googleapis.com/v1beta/${pid}:runPivotReport`, { method: "POST", body: JSON.stringify(body) },
				);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_batch_run_reports",
			"Run up to 5 GA4 reports in a single request, sharing the same property. Saves quota when you need several reports for the same property.",
			{
				property_id: z.string(),
				requests_json: z.string().describe("JSON array of up to 5 request objects, each with dateRanges/dimensions/metrics"),
			},
			async ({ property_id, requests_json }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				let parsed: unknown = [];
				try { parsed = JSON.parse(requests_json); } catch { /* ignore */ }
				const body = { requests: parsed };
				const data = await this.callGoogle(`https://analyticsdata.googleapis.com/v1beta/${pid}:batchRunReports`, { method: "POST", body: JSON.stringify(body) },
				);
				return asTextResult(data);
			},
		);

		// =========================
		// GA4 Admin API additionnels (read-only)
		// =========================

		this.server.tool(
			"ga4_list_properties",
			"List GA4 properties belonging to an account.",
			{ account_id: z.string().describe("Account ID, e.g. 1234567 (without 'accounts/' prefix)") },
			async ({ account_id }) => {
				const aid = account_id.startsWith("accounts/") ? account_id : `accounts/${account_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/properties?filter=parent:${aid}&pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_data_streams",
			"List data streams (web, iOS, Android) configured on a GA4 property.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}/dataStreams?pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_key_events",
			"List the key events (conversions) configured on a GA4 property. Replaces the deprecated conversionEvents.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}/keyEvents?pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_conversion_events",
			"List conversion events (legacy API, still active for older properties). Prefer list_key_events for new properties.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}/conversionEvents?pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_custom_dimensions",
			"List custom dimensions configured on a GA4 property.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}/customDimensions?pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_custom_metrics",
			"List custom metrics configured on a GA4 property.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}/customMetrics?pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_audiences",
			"List audiences configured on a GA4 property. Uses v1alpha API.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1alpha/${pid}/audiences?pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_google_ads_links",
			"List Google Ads accounts linked to a GA4 property.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}/googleAdsLinks?pageSize=200`);
				return asTextResult(data);
			},
		);

		this.server.tool(
			"ga4_list_firebase_links",
			"List Firebase projects linked to a GA4 property.",
			{ property_id: z.string() },
			async ({ property_id }) => {
				const pid = property_id.startsWith("properties/") ? property_id : `properties/${property_id}`;
				const data = await this.callGoogle(`https://analyticsadmin.googleapis.com/v1beta/${pid}/firebaseLinks?pageSize=200`);
				return asTextResult(data);
			},
		);
	}
}

/**
 * Multi-route MCP mounting (Rablab fork).
 *
 * Claude Desktop deduplicates MCP servers by their URL. To allow the same
 * worker to be connected twice (once per Google account, e.g. ppc.rablab@gmail.com
 * and plateformes@rablab.ca), we expose the same MCP on two distinct paths.
 *
 * Each path triggers its own OAuth flow and stores its own tokens.
 * Add a new entry here if you need a third connected account.
 */
export default new OAuthProvider({
	apiHandlers: {
		"/sse": MyMCP.mount("/sse") as any,
		"/sse-plateformes": MyMCP.mount("/sse-plateformes") as any,
	},
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: "/token",
});
