// The Yandex Ads catalog: data, not code. One artifact describing the Direct
// v5 surface — entities (services), their operations classified read/write,
// payload forms and examples. Three faces: the yandex_ads_describe reference
// (progressive disclosure), validation that teaches (a wrong call comes back
// with a hint instead of flying to the API), and the eyes/hands routing (the
// read/write classification is the boundary between tools).
//
// Honesty rule: the catalog hard-rejects only what it KNOWS is wrong (unknown
// entity, a write method through the eyes); unknown field names pass through —
// the live API answer is the primary source of truth and the catalog catches
// up (seeded from the official v5 reference, 2026-08; donor: yandex-ads-mcp).

export type DirectOperation = {
  method: string; // the "method" value in the v5 request body
  kind: 'read' | 'write';
  summary: string;
  params?: string; // human description of the params shape
  example?: unknown; // example "params" object
};

export type DirectEntity = {
  key: string; // enum value exposed to the model
  service: string; // URL segment: /json/v5/{service}
  title: string;
  summary: string;
  operations: DirectOperation[];
  fieldNames?: string[]; // known FieldNames for get (possibly incomplete)
  extraFieldSets?: Record<string, string[]>; // type-specific field sets, e.g. TextCampaignFieldNames
  notes?: string;
};

const GET_PARAMS =
  'params: { SelectionCriteria?: object (filter; omit for all), FieldNames: string[] (required), Page?: { Limit?: number, Offset?: number } }';

// Recurring facts of the write surface, echoed in describe output:
export const WRITE_NOTES =
  'Write results are PER-ITEM: AddResults/UpdateResults/… arrays where each element carries Id on success or Errors/Warnings — always check every element, partial success is normal. Money fields are in micros, i.e. millionths of the currency unit: Bid 5000000 = 5 RUB, DailyBudget.Amount 300000000 = 300 RUB.';

function getOp(summary: string, example: unknown): DirectOperation {
  return { method: 'get', kind: 'read', summary, params: GET_PARAMS, example };
}

function writeOps(methods: string[], of: string): DirectOperation[] {
  return methods.map(method => ({
    method,
    kind: 'write' as const,
    summary: `${method} ${of}`,
  }));
}

// State-change operations (suspend/resume/archive/…): one uniform form.
function idsOp(method: string, summary: string): DirectOperation {
  return {
    method,
    kind: 'write',
    summary,
    params: 'params: { SelectionCriteria: { Ids: number[] } }',
    example: { SelectionCriteria: { Ids: [12345678] } },
  };
}

function writeOp(method: string, summary: string, params: string, example: unknown): DirectOperation {
  return { method, kind: 'write', summary, params, example };
}

export const DIRECT_ENTITIES: DirectEntity[] = [
  {
    key: 'campaigns',
    service: 'campaigns',
    title: 'Campaigns',
    summary: 'Advertising campaigns: settings, strategies, state, budgets.',
    operations: [
      getOp('Select campaigns by criteria', {
        SelectionCriteria: { States: ['ON'] },
        FieldNames: ['Id', 'Name', 'Type', 'Status', 'State', 'DailyBudget'],
        Page: { Limit: 100 },
      }),
      writeOp(
        'add',
        'Create campaigns',
        'params: { Campaigns: [{ Name, StartDate ("YYYY-MM-DD"), TextCampaign?: { BiddingStrategy: { Search: { BiddingStrategyType }, Network: { BiddingStrategyType } } }, DailyBudget?: { Amount (micros), Mode: STANDARD|DISTRIBUTED }, NegativeKeywords?: { Items: string[] }, TimeTargeting?, … }] }',
        {
          Campaigns: [
            {
              Name: 'Поиск — Москва',
              StartDate: '2026-09-01',
              TextCampaign: {
                BiddingStrategy: {
                  Search: { BiddingStrategyType: 'HIGHEST_POSITION' },
                  Network: { BiddingStrategyType: 'SERVING_OFF' },
                },
              },
              DailyBudget: { Amount: 300000000, Mode: 'STANDARD' },
              NegativeKeywords: { Items: ['бесплатно'] },
            },
          ],
        },
      ),
      writeOp(
        'update',
        'Change campaign settings (fields present in the item are replaced)',
        'params: { Campaigns: [{ Id (required), …fields to change, type-specific block (TextCampaign etc.) for strategy changes }] }',
        { Campaigns: [{ Id: 12345678, Name: 'Новое имя', DailyBudget: { Amount: 500000000, Mode: 'STANDARD' } }] },
      ),
      idsOp('delete', 'Delete campaigns (only archived ones can be deleted)'),
      idsOp('suspend', 'Stop impressions of campaigns'),
      idsOp('resume', 'Resume impressions of suspended campaigns'),
      idsOp('archive', 'Archive stopped campaigns'),
      idsOp('unarchive', 'Unarchive campaigns'),
    ],
    fieldNames: [
      'Id', 'Name', 'Type', 'Status', 'State', 'StatusPayment', 'StatusClarification', 'StartDate', 'EndDate',
      'Currency', 'DailyBudget', 'Funds', 'RepresentedBy', 'NegativeKeywords', 'BlockedIps', 'ExcludedSites',
      'Statistics', 'SourceId', 'TimeTargeting', 'TimeZone', 'ClientInfo', 'Notification',
    ],
    extraFieldSets: {
      TextCampaignFieldNames: [
        'BiddingStrategy', 'Settings', 'CounterIds', 'RelevantKeywords', 'PriorityGoals', 'AttributionModel',
      ],
      DynamicTextCampaignFieldNames: ['BiddingStrategy', 'Settings', 'CounterIds', 'PriorityGoals', 'AttributionModel'],
      SmartCampaignFieldNames: ['BiddingStrategy', 'Settings', 'CounterId', 'PriorityGoals', 'AttributionModel'],
      UnifiedCampaignFieldNames: ['BiddingStrategy', 'Settings', 'CounterIds', 'PriorityGoals', 'AttributionModel'],
    },
    notes:
      'SelectionCriteria filters: Ids, Types, Statuses, States, StatusesPayment. Campaign types: TEXT_CAMPAIGN, UNIFIED_CAMPAIGN, SMART_CAMPAIGN, DYNAMIC_TEXT_CAMPAIGN, MOBILE_APP_CAMPAIGN, MCBANNER_CAMPAIGN, CPM_BANNER_CAMPAIGN. Type-specific settings come via the extra field sets (e.g. TextCampaignFieldNames).',
  },
  {
    key: 'adgroups',
    service: 'adgroups',
    title: 'Ad groups',
    summary: 'Ad groups inside campaigns: regions, negative keywords, tracking params.',
    operations: [
      getOp('Select ad groups', {
        SelectionCriteria: { CampaignIds: [123456] },
        FieldNames: ['Id', 'Name', 'CampaignId', 'Status', 'RegionIds'],
      }),
      writeOp(
        'add',
        'Create ad groups in a campaign',
        'params: { AdGroups: [{ Name, CampaignId, RegionIds: number[] (0 = everywhere, negative id = exclude), NegativeKeywords?: { Items }, TrackingParams? }] }',
        { AdGroups: [{ Name: 'Группа 1', CampaignId: 12345678, RegionIds: [213] }] },
      ),
      writeOp(
        'update',
        'Change ad group settings',
        'params: { AdGroups: [{ Id (required), …fields to change }] }',
        { AdGroups: [{ Id: 1234567890, NegativeKeywords: { Items: ['дешево'] } }] },
      ),
      idsOp('delete', 'Delete ad groups'),
    ],
    fieldNames: [
      'Id', 'Name', 'CampaignId', 'RegionIds', 'Status', 'ServingStatus', 'Type', 'Subtype',
      'NegativeKeywords', 'NegativeKeywordSharedSetIds', 'TrackingParams',
    ],
    notes: 'SelectionCriteria requires at least one of: Ids, CampaignIds. RegionIds 0 = all regions; negative region = exclusion.',
  },
  {
    key: 'ads',
    service: 'ads',
    title: 'Ads',
    summary: 'Ads of every type; text ads carry title/text/href in TextAd fields.',
    operations: [
      getOp('Select ads', {
        SelectionCriteria: { CampaignIds: [123456], States: ['ON'] },
        FieldNames: ['Id', 'AdGroupId', 'CampaignId', 'Status', 'State', 'Type'],
        TextAdFieldNames: ['Title', 'Title2', 'Text', 'Href'],
      }),
      writeOp(
        'add',
        'Create ads in an ad group (born as drafts — send to moderation with moderate)',
        'params: { Ads: [{ AdGroupId, TextAd?: { Title (≤56), Title2? (≤30), Text (≤81), Href, Mobile: "YES"|"NO", DisplayUrlPath?, VCardId?, AdImageHash?, SitelinkSetId? } }] } — or MobileAppAd/DynamicTextAd/… per group type',
        {
          Ads: [
            {
              AdGroupId: 1234567890,
              TextAd: {
                Title: 'Слоны с доставкой',
                Title2: 'Сегодня скидка',
                Text: 'Большие и маленькие. Звоните!',
                Href: 'https://example.com',
                Mobile: 'NO',
              },
            },
          ],
        },
      ),
      writeOp(
        'update',
        'Change ads (the ad returns to moderation after edits)',
        'params: { Ads: [{ Id (required), TextAd?: { …fields to change } }] }',
        { Ads: [{ Id: 123456789012, TextAd: { Title: 'Новый заголовок' } }] },
      ),
      idsOp('delete', 'Delete ads (drafts and archived only)'),
      idsOp('moderate', 'Send draft ads to moderation'),
      idsOp('suspend', 'Stop impressions of ads'),
      idsOp('resume', 'Resume impressions of ads'),
      idsOp('archive', 'Archive stopped ads'),
      idsOp('unarchive', 'Unarchive ads'),
    ],
    fieldNames: ['Id', 'CampaignId', 'AdGroupId', 'Status', 'State', 'StatusClarification', 'Type', 'Subtype', 'AgeLabel'],
    extraFieldSets: {
      TextAdFieldNames: [
        'Title', 'Title2', 'Text', 'Href', 'Mobile', 'DisplayUrlPath', 'DisplayDomain', 'VCardId', 'AdImageHash',
        'SitelinkSetId', 'VideoExtension',
      ],
      MobileAppAdFieldNames: ['Title', 'Text', 'TrackingUrl', 'Action', 'AdImageHash', 'Features'],
      DynamicTextAdFieldNames: ['Text', 'VCardId', 'AdImageHash', 'SitelinkSetId'],
    },
    notes: 'SelectionCriteria requires at least one of: Ids, AdGroupIds, CampaignIds. moderate sends drafts to moderation.',
  },
  {
    key: 'keywords',
    service: 'keywords',
    title: 'Keywords',
    summary: 'Keywords and autotargetings of ad groups, with bids and per-phrase statistics.',
    operations: [
      getOp('Select keywords', {
        SelectionCriteria: { AdGroupIds: [1234567] },
        FieldNames: ['Id', 'Keyword', 'AdGroupId', 'CampaignId', 'Status', 'State', 'Bid'],
      }),
      writeOp(
        'add',
        'Add keywords/autotargetings to ad groups',
        'params: { Keywords: [{ AdGroupId, Keyword (with operators: "-минус", "+плюс", "!форма", [порядок]), Bid? (micros, manual strategies), UserParam1?, UserParam2? }] }',
        { Keywords: [{ AdGroupId: 1234567890, Keyword: 'купить слона -бесплатно', Bid: 5000000 }] },
      ),
      writeOp(
        'update',
        'Change keywords (keyword text change = delete + add under the hood)',
        'params: { Keywords: [{ Id (required), …fields to change }] }',
        { Keywords: [{ Id: 12345678901, Bid: 7000000 }] },
      ),
      idsOp('delete', 'Delete keywords'),
      idsOp('suspend', 'Stop impressions on keywords'),
      idsOp('resume', 'Resume impressions on keywords'),
    ],
    fieldNames: [
      'Id', 'Keyword', 'AdGroupId', 'CampaignId', 'Bid', 'ContextBid', 'StrategyPriority', 'UserParam1', 'UserParam2',
      'Status', 'State', 'ServingStatus', 'StatisticsSearch', 'StatisticsNetwork', 'AutotargetingCategories',
    ],
    notes: 'SelectionCriteria requires at least one of: Ids, AdGroupIds, CampaignIds.',
  },
  {
    key: 'bids',
    service: 'bids',
    title: 'Bids',
    summary: 'Bids per keyword/group/campaign (manual strategies).',
    operations: [
      getOp('Select bids', {
        SelectionCriteria: { CampaignIds: [123456] },
        FieldNames: ['KeywordId', 'AdGroupId', 'CampaignId', 'Bid', 'ContextBid', 'ServingStatus'],
      }),
      writeOp(
        'set',
        'Set bids manually (per keyword, ad group or campaign)',
        'params: { Bids: [{ KeywordId | AdGroupId | CampaignId, Bid? (micros, search), ContextBid? (micros, network) }] }',
        { Bids: [{ KeywordId: 12345678901, Bid: 5000000 }] },
      ),
      writeOp(
        'setAuto',
        'Set bids by rule (traffic volume / coverage based)',
        'params: { Bids: [{ CampaignId | AdGroupId | KeywordId, MaxBid? (micros), Scope: ["SEARCH"|"NETWORK"], Position? }] }',
        { Bids: [{ CampaignId: 12345678, MaxBid: 10000000, Scope: ['SEARCH'] }] },
      ),
    ],
    fieldNames: [
      'KeywordId', 'AdGroupId', 'CampaignId', 'Bid', 'ContextBid', 'StrategyPriority', 'CompetitorsBids',
      'SearchPrices', 'ContextCoverage', 'MinSearchPrice', 'CurrentSearchPrice', 'AuctionBids', 'ServingStatus',
    ],
  },
  {
    key: 'keywordbids',
    service: 'keywordbids',
    title: 'Keyword bids',
    summary: 'Newer bid interface: search/network bids with auction data per keyword.',
    operations: [
      getOp('Select keyword bids', {
        SelectionCriteria: { CampaignIds: [123456] },
        FieldNames: ['KeywordId', 'AdGroupId', 'CampaignId', 'ServingStatus'],
        SearchFieldNames: ['Bid', 'AuctionBids'],
        NetworkFieldNames: ['Bid', 'Coverage'],
      }),
      writeOp(
        'set',
        'Set search/network bids per keyword',
        'params: { KeywordBids: [{ KeywordId | AdGroupId | CampaignId, SearchBid? (micros), NetworkBid? (micros) }] }',
        { KeywordBids: [{ KeywordId: 12345678901, SearchBid: 5000000 }] },
      ),
      writeOp(
        'setAuto',
        'Set bids by target traffic volume',
        'params: { KeywordBids: [{ KeywordId | AdGroupId | CampaignId, TargetTrafficVolume (5..100) }] }',
        { KeywordBids: [{ AdGroupId: 1234567890, TargetTrafficVolume: 85 }] },
      ),
    ],
    notes: 'Field names split by placement: FieldNames + SearchFieldNames + NetworkFieldNames.',
  },
  {
    key: 'bidmodifiers',
    service: 'bidmodifiers',
    title: 'Bid modifiers',
    summary: 'Bid adjustments: mobile, demographics, region, retargeting, video, weather.',
    operations: [
      getOp('Select bid modifiers', {
        SelectionCriteria: { CampaignIds: [123456], Levels: ['CAMPAIGN'] },
        FieldNames: ['Id', 'CampaignId', 'AdGroupId', 'Level', 'Type'],
      }),
      writeOp(
        'add',
        'Add bid adjustments',
        'params: { BidModifiers: [{ CampaignId | AdGroupId, MobileAdjustment?: { BidModifier (0..1300, %) } | DemographicsAdjustments?: [{ Gender?, Age?, BidModifier }] | RegionalAdjustments?: [{ RegionId, BidModifier }] | RetargetingAdjustments?: [{ RetargetingConditionId, BidModifier }] }] }',
        { BidModifiers: [{ CampaignId: 12345678, MobileAdjustment: { BidModifier: 50 } }] },
      ),
      writeOp(
        'set',
        'Change existing adjustment values',
        'params: { BidModifiers: [{ Id, BidModifier }] }',
        { BidModifiers: [{ Id: 123456, BidModifier: 120 }] },
      ),
      writeOp(
        'toggle',
        'Enable/disable a whole adjustment type on a campaign or group',
        'params: { BidModifierToggleItems: [{ CampaignId | AdGroupId, Type (e.g. MOBILE_ADJUSTMENT, DEMOGRAPHICS_ADJUSTMENT), Enabled: "YES"|"NO" }] }',
        { BidModifierToggleItems: [{ CampaignId: 12345678, Type: 'MOBILE_ADJUSTMENT', Enabled: 'NO' }] },
      ),
      idsOp('delete', 'Delete bid adjustments'),
    ],
    notes: 'Type-specific field sets exist per modifier kind (MobileAdjustmentFieldNames, DemographicsAdjustmentFieldNames, RegionalAdjustmentFieldNames, …).',
  },
  {
    key: 'negativekeywordsharedsets',
    service: 'negativekeywordsharedsets',
    title: 'Shared negative keyword sets',
    summary: 'Reusable negative keyword lists attached to ad groups.',
    operations: [
      getOp('Select shared sets', { FieldNames: ['Id', 'Name', 'NegativeKeywords', 'Associated'] }),
      ...writeOps(['add', 'update', 'delete'], 'shared sets'),
    ],
    fieldNames: ['Id', 'Name', 'NegativeKeywords', 'Associated'],
  },
  {
    key: 'keywordsresearch',
    service: 'keywordsresearch',
    title: 'Keywords research',
    summary: 'Pre-flight phrase checks: search volume, duplicates. Read-only computations.',
    operations: [
      {
        method: 'hasSearchVolume',
        kind: 'read',
        summary: 'Whether phrases have nonzero search volume per device type',
        params:
          'params: { SelectionCriteria: { Keywords: string[], RegionIds: number[] }, FieldNames: ["Keyword","HasSearchVolume"] }',
        example: {
          SelectionCriteria: { Keywords: ['купить слона'], RegionIds: [213] },
          FieldNames: ['Keyword', 'HasSearchVolume'],
        },
      },
      {
        method: 'deduplicate',
        kind: 'read',
        summary: 'Find duplicate/overlapping phrases in a submitted list (account state untouched)',
        params: 'params: { Keywords: [{ Keyword: string, Id?: number }], Operation?: ["MERGE_DUPLICATES"|"ELIMINATE_OVERLAPPING"] }',
        example: { Keywords: [{ Keyword: 'купить слона' }, { Keyword: 'слона купить' }] },
      },
    ],
  },
  {
    key: 'businesses',
    service: 'businesses',
    title: 'Businesses',
    summary: 'Business profiles usable in ads.',
    operations: [getOp('Select business profiles', { FieldNames: ['Id', 'Name', 'Ogrn'] })],
  },
  {
    key: 'adimages',
    service: 'adimages',
    title: 'Ad images',
    summary: 'Uploaded ad images referenced by hash.',
    operations: [
      getOp('Select ad images', { FieldNames: ['AdImageHash', 'Name', 'Type', 'Subtype', 'OriginalUrl', 'Associated'] }),
      ...writeOps(['add', 'delete'], 'ad images'),
    ],
  },
  {
    key: 'creatives',
    service: 'creatives',
    title: 'Creatives',
    summary: 'Display/smart creatives.',
    operations: [
      getOp('Select creatives', { FieldNames: ['Id', 'Name', 'Type'] }),
      ...writeOps(['add'], 'creatives'),
    ],
  },
  {
    key: 'advideos',
    service: 'advideos',
    title: 'Ad videos',
    summary: 'Uploaded ad videos referenced by id.',
    operations: [
      getOp('Select ad videos', { FieldNames: ['Id', 'Name', 'Status'] }),
      ...writeOps(['add'], 'ad videos'),
    ],
  },
  {
    key: 'turbopages',
    service: 'turbopages',
    title: 'Turbo pages',
    summary: 'Turbo landing pages available to the account.',
    operations: [getOp('Select turbo pages', { FieldNames: ['Id', 'Name', 'Href', 'PreviewHref'] })],
  },
  {
    key: 'leads',
    service: 'leads',
    title: 'Leads',
    summary: 'Form submissions from turbo pages.',
    operations: [
      getOp('Select leads', {
        SelectionCriteria: { TurboPageIds: [123] },
        FieldNames: ['Id', 'SubmittedAt', 'TurboPageId', 'TurboPageName', 'Data'],
      }),
    ],
  },
  {
    key: 'sitelinks',
    service: 'sitelinks',
    title: 'Sitelinks',
    summary: 'Sitelink sets attached to ads.',
    operations: [
      getOp('Select sitelink sets', { FieldNames: ['Id', 'Sitelinks'] }),
      ...writeOps(['add', 'delete'], 'sitelink sets'),
    ],
  },
  {
    key: 'vcards',
    service: 'vcards',
    title: 'Virtual cards',
    summary: 'Contact vCards attached to ads.',
    operations: [
      getOp('Select vCards', { FieldNames: ['Id', 'CampaignId', 'Company', 'Phone', 'City'] }),
      ...writeOps(['add', 'delete'], 'vCards'),
    ],
  },
  {
    key: 'adextensions',
    service: 'adextensions',
    title: 'Ad extensions',
    summary: 'Callouts and other ad extensions.',
    operations: [
      getOp('Select ad extensions', { FieldNames: ['Id', 'Type', 'Status', 'Associated'] }),
      ...writeOps(['add', 'delete'], 'ad extensions'),
    ],
  },
  {
    key: 'audiencetargets',
    service: 'audiencetargets',
    title: 'Audience targets',
    summary: 'Audience targeting conditions (retargeting/interests) of ad groups.',
    operations: [
      getOp('Select audience targets', {
        SelectionCriteria: { CampaignIds: [123456] },
        FieldNames: ['Id', 'AdGroupId', 'CampaignId', 'RetargetingListId', 'State', 'ContextBid'],
      }),
      ...writeOps(['add', 'delete', 'suspend', 'resume', 'setBids'], 'audience targets'),
    ],
  },
  {
    key: 'retargetinglists',
    service: 'retargetinglists',
    title: 'Retargeting lists',
    summary: 'Retargeting conditions built on Metrika goals/segments and Audience segments.',
    operations: [
      getOp('Select retargeting lists', { FieldNames: ['Id', 'Name', 'Description', 'Type', 'Rules', 'Scope', 'Available'] }),
      ...writeOps(['add', 'update', 'delete'], 'retargeting lists'),
    ],
  },
  {
    key: 'smartadtargets',
    service: 'smartadtargets',
    title: 'Smart ad targets',
    summary: 'Filters for smart banners/smart campaigns.',
    operations: [
      getOp('Select smart ad targets', {
        SelectionCriteria: { CampaignIds: [123456] },
        FieldNames: ['Id', 'AdGroupId', 'CampaignId', 'Name', 'State'],
      }),
      ...writeOps(['add', 'update', 'delete', 'suspend', 'resume', 'setBids'], 'smart ad targets'),
    ],
  },
  {
    key: 'dynamictextadtargets',
    service: 'dynamictextadtargets',
    title: 'Dynamic text ad targets (webpages)',
    summary: 'Targeting conditions for dynamic text ads.',
    operations: [
      getOp('Select dynamic ad targets', {
        SelectionCriteria: { CampaignIds: [123456] },
        FieldNames: ['Id', 'AdGroupId', 'CampaignId', 'Name', 'State', 'Conditions'],
      }),
      ...writeOps(['add', 'delete', 'suspend', 'resume', 'setBids'], 'dynamic ad targets'),
    ],
  },
  {
    key: 'feeds',
    service: 'feeds',
    title: 'Feeds',
    summary: 'Product feeds for smart/dynamic campaigns.',
    operations: [
      getOp('Select feeds', { FieldNames: ['Id', 'Name', 'BusinessType', 'SourceType', 'UpdatedAt', 'CampaignIds', 'Status'] }),
      ...writeOps(['add', 'update', 'delete'], 'feeds'),
    ],
  },
  {
    key: 'clients',
    service: 'clients',
    title: 'Client (this login)',
    summary: 'The advertiser behind the addressed account: settings, representatives, units.',
    operations: [
      getOp('Read the client of this account', {
        FieldNames: ['ClientId', 'ClientInfo', 'Login', 'CreatedAt', 'Currency', 'Grants', 'Settings', 'Representatives', 'Restrictions', 'VatRate'],
      }),
      ...writeOps(['update'], 'client settings'),
    ],
    notes: 'get takes FieldNames only (no SelectionCriteria) — it always describes the token\'s own login.',
  },
  {
    key: 'dictionaries',
    service: 'dictionaries',
    title: 'Dictionaries',
    summary: 'Reference data: regions, currencies, time zones, interests, constants.',
    operations: [
      {
        method: 'get',
        kind: 'read',
        summary: 'Fetch reference dictionaries by name',
        params:
          'params: { DictionaryNames: string[] } — of: Currencies, MetroStations, GeoRegions, TimeZones, Constants, AdCategories, OperationSystemVersions, SupplySidePlatforms, Interests, AudienceCriteriaTypes, AudienceDemographicProfiles, OsTypes',
        example: { DictionaryNames: ['GeoRegions'] },
      },
    ],
    notes: 'GeoRegions is large — fetch once and reuse. Region 225 = Russia, 213 = Moscow.',
  },
  {
    key: 'changes',
    service: 'changes',
    title: 'Changes',
    summary: 'Incremental sync: what changed in the account since a timestamp.',
    operations: [
      {
        method: 'checkDictionaries',
        kind: 'read',
        summary: 'Whether reference dictionaries changed since Timestamp',
        params: 'params: { Timestamp: "YYYY-MM-DDThh:mm:ssZ" }',
        example: { Timestamp: '2026-08-01T00:00:00Z' },
      },
      {
        method: 'checkCampaigns',
        kind: 'read',
        summary: 'Which campaigns changed since Timestamp',
        params: 'params: { Timestamp: "YYYY-MM-DDThh:mm:ssZ" }',
        example: { Timestamp: '2026-08-01T00:00:00Z' },
      },
      {
        method: 'check',
        kind: 'read',
        summary: 'Which campaigns/ad groups/ads changed since Timestamp',
        params:
          'params: { CampaignIds?|AdGroupIds?|AdIds?: number[], FieldNames: ["CampaignIds","AdGroupIds","AdIds"], Timestamp: string }',
        example: { CampaignIds: [123456], FieldNames: ['CampaignIds', 'AdGroupIds', 'AdIds'], Timestamp: '2026-08-01T00:00:00Z' },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Reports (a separate dialect: TSV over /json/v5/reports)
// ---------------------------------------------------------------------------

export const REPORT_TYPES = [
  'ACCOUNT_PERFORMANCE_REPORT',
  'CAMPAIGN_PERFORMANCE_REPORT',
  'ADGROUP_PERFORMANCE_REPORT',
  'AD_PERFORMANCE_REPORT',
  'CRITERIA_PERFORMANCE_REPORT',
  'CUSTOM_REPORT',
  'SEARCH_QUERY_PERFORMANCE_REPORT',
  'REACH_AND_FREQUENCY_PERFORMANCE_REPORT',
] as const;

export const REPORT_DATE_RANGES = [
  'TODAY',
  'YESTERDAY',
  'LAST_3_DAYS',
  'LAST_5_DAYS',
  'LAST_7_DAYS',
  'LAST_14_DAYS',
  'LAST_30_DAYS',
  'LAST_90_DAYS',
  'LAST_365_DAYS',
  'THIS_WEEK_MON_TODAY',
  'THIS_WEEK_SUN_TODAY',
  'LAST_WEEK',
  'LAST_BUSINESS_WEEK',
  'LAST_WEEK_SUN_SAT',
  'THIS_MONTH',
  'LAST_MONTH',
  'ALL_TIME',
  'CUSTOM_DATE',
  'AUTO',
] as const;

export const REPORT_FIELDS: Record<string, string[]> = {
  slices: [
    'Date', 'Week', 'Month', 'Quarter', 'Year', 'CampaignId', 'CampaignName', 'CampaignType', 'AdGroupId',
    'AdGroupName', 'AdId', 'CriterionId', 'Criterion', 'CriteriaType', 'SearchQuery', 'Query', 'Placement',
    'AdNetworkType', 'Device', 'Age', 'Gender', 'CarrierType', 'MobilePlatform', 'Slot', 'ClickType', 'MatchType',
    'TargetingLocationId', 'TargetingLocationName', 'LocationOfPresenceId', 'LocationOfPresenceName',
  ],
  metrics: [
    'Impressions', 'Clicks', 'Ctr', 'Cost', 'AvgCpc', 'AvgCpm', 'AvgPageviews', 'AvgTrafficVolume', 'BounceRate',
    'Bounces', 'Conversions', 'ConversionRate', 'CostPerConversion', 'GoalsRoi', 'Revenue', 'Sessions', 'Profit',
    'AvgEffectiveBid', 'WeightedImpressions', 'WeightedCtr', 'AvgImpressionFrequency', 'ImpressionReach',
  ],
};

export const REPORTS_REFERENCE = [
  'Reports service: statistics over the account, returned as TSV. Money in currency units with VAT per include_vat.',
  `report_type: ${REPORT_TYPES.join(', ')}.`,
  `date_range_type: ${REPORT_DATE_RANGES.join(', ')} (CUSTOM_DATE requires date_from/date_to YYYY-MM-DD).`,
  `Slice fields (dimensions): ${REPORT_FIELDS.slices.join(', ')}.`,
  `Metric fields: ${REPORT_FIELDS.metrics.join(', ')}.`,
  'Conversion fields (Conversions, Revenue, …) can be split by goals via goal_ids.',
  'filter: [{ Field, Operator: EQUALS|NOT_EQUALS|IN|NOT_IN|LESS_THAN|GREATER_THAN|STARTS_WITH_IGNORE_CASE|DOES_NOT_START_WITH_IGNORE_CASE, Values: string[] }].',
  'SEARCH_QUERY_PERFORMANCE_REPORT shows real user queries; CRITERIA_PERFORMANCE_REPORT shows per-keyword stats.',
  'Reports may be built offline: the tool waits briefly and polls; if still not ready it says so — repeat the same call later, it resumes the same report.',
].join('\n');

// ---------------------------------------------------------------------------
// Metrika (eyes only — the capability performs no Metrika writes)
// ---------------------------------------------------------------------------

export const METRIKA_GET_RESOURCES = ['counter', 'goals', 'segments', 'filters', 'operations'] as const;

export const METRIKA_REFERENCE = [
  'Yandex Metrika, read-only. The subject is a COUNTER: one login sees its own and guest counters — discover them with yandex_metrika_counters (id, name, site, permission), then pass counter_id everywhere.',
  '',
  `Settings (yandex_metrika_get, resource): ${METRIKA_GET_RESOURCES.join(', ')} — counter details, goals (with ids for conversion metrics), segments, filters, operations.`,
  '',
  'Statistics (yandex_metrika_report → Stats API /stat/v1/data):',
  '- metrics (required, up to 20): ym:s:visits, ym:s:pageviews, ym:s:users, ym:s:bounceRate, ym:s:pageDepth, ym:s:avgVisitDurationSeconds, ym:s:percentNewVisitors, ym:s:sumGoalReachesAny; per-goal: ym:s:goal<GOAL_ID>reaches, ym:s:goal<GOAL_ID>conversionRate, ym:s:goal<GOAL_ID>revenue; e-commerce: ym:s:ecommercePurchases, ym:s:ecommerceRevenue; Direct ad traffic (ym:ad namespace): ym:ad:visits, ym:ad:clicks, ym:ad:RUBAdCost, ym:ad:goal<GOAL_ID>reaches.',
  '- dimensions (up to 10): ym:s:date, ym:s:dayOfWeek, ym:s:trafficSource, ym:s:lastsignTrafficSource, ym:s:sourceEngine, ym:s:searchPhrase, ym:s:referalSource, ym:s:UTMCampaign, ym:s:UTMSource, ym:s:UTMMedium, ym:s:regionCountry, ym:s:regionCity, ym:s:deviceCategory, ym:s:operatingSystem, ym:s:browser, ym:s:startURL; Direct: ym:ad:directOrder (campaign), ym:ad:directBannerGroup, ym:ad:directBanner, ym:ad:directSearchPhrase, ym:ad:directPlatform.',
  '- Metric namespaces must not mix in one query: ym:s:* (sessions) with ym:s:* dimensions, ym:ad:* (Direct clicks) with ym:ad:* dimensions.',
  '- date1/date2: YYYY-MM-DD or relative (today, yesterday, NdaysAgo). Defaults: last week.',
  "- filters: expression like \"ym:s:trafficSource=='ad'\" (operators ==, !=, >, <, =@ contains, =~ regex; AND/OR).",
  '- sort: metric or dimension name, "-" prefix for descending (default: -first metric). limit up to 100000 (default 100), offset from 1.',
  '- Sampling: the answer reports sampled/sample_share; accuracy=full lowers sampling at the cost of speed.',
  '',
  'A closed loop with Direct: ym:ad:directOrder names the Direct campaign, so Direct statistics (spend) join Metrika conversions per campaign.',
].join('\n');

// ---------------------------------------------------------------------------
// Lookup and teaching validation
// ---------------------------------------------------------------------------

const entityByKey = new Map(DIRECT_ENTITIES.map(entity => [entity.key, entity]));

export function directEntityKeys(): string[] {
  return DIRECT_ENTITIES.map(entity => entity.key);
}

export function getDirectEntity(key: string): DirectEntity | null {
  return entityByKey.get(key) ?? null;
}

export function readMethods(entity: DirectEntity): DirectOperation[] {
  return entity.operations.filter(op => op.kind === 'read');
}

export function writeMethods(entity: DirectEntity): DirectOperation[] {
  return entity.operations.filter(op => op.kind === 'write');
}

// Resolves an eyes call: entity + optional method → service + method, or a
// teaching error. Hard checks only on what the catalog is authoritative
// about: entity existence and the read/write classification.
export function resolveReadCall(entityKey: string, method: string | null | undefined): { entity: DirectEntity; method: string } {
  const entity = getDirectEntity(entityKey);

  if (!entity) {
    throw new Error(`Unknown entity "${entityKey}". Entities: ${directEntityKeys().join(', ')}. See yandex_ads_describe.`);
  }

  const reads = readMethods(entity);
  const chosen =
    method?.trim() || (reads.some(op => op.method === 'get') ? 'get' : reads.length === 1 ? reads[0].method : null);

  if (!chosen) {
    throw new Error(
      `Entity "${entity.key}" has several read methods — pass one explicitly: ${reads.map(r => r.method).join(', ')}. See yandex_ads_describe("${entity.key}").`,
    );
  }

  const op = entity.operations.find(candidate => candidate.method === chosen);

  if (!op) {
    throw new Error(
      `Entity "${entity.key}" has no method "${chosen}". Read methods: ${reads.map(r => r.method).join(', ')}. See yandex_ads_describe("${entity.key}").`,
    );
  }

  if (op.kind === 'write') {
    throw new Error(
      `"${entity.key}.${op.method}" is a WRITE operation — yandex_direct_get is read-only. Read methods of "${entity.key}": ${reads.map(r => r.method).join(', ')}.`,
    );
  }

  return { entity, method: op.method };
}

// Resolves a hands call: entity + write method, or a teaching error. The
// mirror of resolveReadCall across the eyes/hands boundary.
export function resolveWriteCall(entityKey: string, method: string): { entity: DirectEntity; method: string } {
  const entity = getDirectEntity(entityKey);

  if (!entity) {
    throw new Error(`Unknown entity "${entityKey}". Entities: ${directEntityKeys().join(', ')}. See yandex_ads_describe.`);
  }

  const writes = writeMethods(entity);
  const op = entity.operations.find(candidate => candidate.method === method.trim());

  if (!op) {
    throw new Error(
      `Entity "${entity.key}" has no operation "${method}". Write operations: ${writes.map(w => w.method).join(', ') || '(none)'}. See yandex_ads_describe("${entity.key}").`,
    );
  }

  if (op.kind === 'read') {
    throw new Error(
      `"${entity.key}.${op.method}" is a READ operation — use yandex_direct_get for it. Write operations of "${entity.key}": ${writes.map(w => w.method).join(', ') || '(none)'}.`,
    );
  }

  return { entity, method: op.method };
}

// Every write method across the catalog — the enum of the hands tool.
export function directWriteMethodNames(): string[] {
  return [...new Set(DIRECT_ENTITIES.flatMap(entity => writeMethods(entity).map(op => op.method)))].sort();
}

// ---------------------------------------------------------------------------
// The describe reference (progressive disclosure)
// ---------------------------------------------------------------------------

function describeOverview(): string {
  const lines = DIRECT_ENTITIES.map(entity => {
    const reads = readMethods(entity).map(op => op.method).join('/');
    const writes = writeMethods(entity).map(op => op.method).join('/');

    return `- ${entity.key}: ${entity.summary} [read: ${reads}${writes ? `; write: ${writes}` : ''}]`;
  });

  return [
    'Yandex Direct API v5 entities (use yandex_direct_get for reads; write operations are a separate tool):',
    ...lines,
    '- reports: statistics as TSV via yandex_direct_report [read] — describe("reports") for types, fields and ranges.',
    '- metrika: Yandex Metrika, read-only (yandex_metrika_counters / yandex_metrika_get / yandex_metrika_report) — describe("metrika") for metrics, dimensions and resources.',
    '',
    'Call yandex_ads_describe with entity (and optionally operation) for payload forms and examples.',
    WRITE_NOTES,
  ].join('\n');
}

function describeEntity(entity: DirectEntity): string {
  const parts = [
    `${entity.title} (entity: ${entity.key}, service: /json/v5/${entity.service})`,
    entity.summary,
    '',
    'Operations:',
    ...entity.operations.map(op => `- ${op.method} [${op.kind}]: ${op.summary}`),
  ];

  if (entity.fieldNames?.length) {
    parts.push('', `FieldNames for get (known set; the API may accept more): ${entity.fieldNames.join(', ')}`);
  }

  if (entity.extraFieldSets) {
    for (const [setName, fields] of Object.entries(entity.extraFieldSets)) {
      parts.push(`${setName}: ${fields.join(', ')}`);
    }
  }

  if (entity.notes) {
    parts.push('', entity.notes);
  }

  parts.push('', `Details of one operation: yandex_ads_describe("${entity.key}", "<operation>").`);

  return parts.join('\n');
}

function describeOperation(entity: DirectEntity, methodName: string): string {
  const op = entity.operations.find(candidate => candidate.method === methodName);

  if (!op) {
    return `Entity "${entity.key}" has no operation "${methodName}". Operations: ${entity.operations.map(o => o.method).join(', ')}.`;
  }

  const parts = [`${entity.key}.${op.method} [${op.kind}]: ${op.summary}`];

  if (op.params) {
    parts.push('', op.params);
  } else {
    parts.push(
      '',
      'Payload form not seeded in the catalog yet. Standard v5 shapes: add/update → { <Entities>: [{ … }] }; state operations → { SelectionCriteria: { Ids: number[] } }. Official reference: https://yandex.ru/dev/direct/doc/ref-v5/. The live API answer is authoritative — its errors name the expected fields.',
    );
  }

  if (op.example !== undefined) {
    parts.push('', `Example params:`, JSON.stringify(op.example, null, 2));
  }

  if (op.kind === 'write') {
    parts.push('', `Runs through yandex_direct_action, not yandex_direct_get. ${WRITE_NOTES}`);
  }

  return parts.join('\n');
}

export function describeCatalog(entityKey?: string | null, operation?: string | null): string {
  if (!entityKey) {
    return describeOverview();
  }

  if (entityKey === 'reports') {
    return REPORTS_REFERENCE;
  }

  if (entityKey === 'metrika') {
    return METRIKA_REFERENCE;
  }

  const entity = getDirectEntity(entityKey);

  if (!entity) {
    return `Unknown entity "${entityKey}". Entities: ${directEntityKeys().join(', ')}, reports, metrika.`;
  }

  return operation ? describeOperation(entity, operation) : describeEntity(entity);
}
