import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Configuration
 */
const DEBUG = false;
const FETCH_CONCURRENCY = 24;
const SPT_ASSETS_BASE = 'https://raw.githubusercontent.com/sp-tarkov/server-csharp/refs/heads/main/Libraries/SPTarkov.Server.Assets/SPT_Data/database/templates';
const SPT_REPO = 'https://github.com/sp-tarkov/server-csharp.git';
const SPT_ITEMS_PATH = 'Libraries/SPTarkov.Server.Assets/SPT_Data/database/templates/items.json';

const main = (async () => {
    // Fetch data
    if (!DEBUG)
    {
        // Fetch item lists from tarkov.dev so we know which item ids have current flea data
        await fetchTarkovDevItems('regular');
        await fetchTarkovDevItems('pve');

        // Fetch the latest prices.json and handbook.json from SPT's git repo.
        // items.json is stored in SPT's custom Git LFS and cannot be fetched via raw.githubusercontent.com.
        await downloadFile(`${SPT_ASSETS_BASE}/handbook.json`, 'spthandbook.json');
        await downloadFile(`${SPT_ASSETS_BASE}/prices.json`, 'sptprices.json');
        await downloadItemsJson();
    }

    // PvP prices are fucked, but users want them anyways, good luck
    await processData('regular');
    await processData('pve');
});

const fetchTarkovDevItems = (async (gameMode) => {
    const response = await fetch(`https://json.tarkov.dev/${gameMode}/items`);
    if (!response.ok)
    {
        throw new Error(`Failed to fetch tarkov.dev ${gameMode} items: ${response.status} ${response.statusText}`);
    }

    const tarkovDevItems = await response.json();
    fs.writeFileSync(`tarkovdevitems-${gameMode}.json`, JSON.stringify(tarkovDevItems, null, 4));
})

const processData = (async (gameMode) => {
    // Read in data
    const tarkovDevItems = readJsonFile(`tarkovdevitems-${gameMode}.json`);
    const sptHandbook = readJsonFile('spthandbook.json');
    const sptItems = readJsonFile('items.json', { optional: true });
    const sptPrices = readJsonFile('sptprices.json');
    const sptItemIds = sptItems ? new Set(Object.keys(sptItems)) : new Set(Object.keys(sptPrices));

    // Start with a base of the SPT price list
    const priceList = {};
    for (const itemId in sptPrices)
    {
        priceList[itemId] = {
            priceMin: sptPrices[itemId],
            price: sptPrices[itemId],
            offerCount: 0,
            timestamp: 0
        };
    }

    // Filter tarkov.dev prices in the same way SPT does
    const filteredTarkovDevPrices = processTarkovDevItems(gameMode, tarkovDevItems);
    const currentPriceData = await fetchCurrentPriceData(gameMode, filteredTarkovDevPrices);

    // Get a price for each item in the items list
    for (const itemId in filteredTarkovDevPrices)
    {
        // Skip items that aren't in SPT's item database, this tends to be presets
        if (!sptItemIds.has(itemId))
        {
            continue;
        }

        const itemPrice = currentPriceData[itemId] ?? filteredTarkovDevPrices[itemId];
        if (itemPrice.Price)
        {
            if (DEBUG) console.log(`[${gameMode}] Adding item: ${itemPrice.TemplateId} ${itemPrice.Name} -> ${itemPrice.Price}`);
            priceList[itemId] = {
                priceMin: itemPrice.PriceMin,
                price: itemPrice.Price,
                offerCount: itemPrice.OfferCount,
                timestamp: itemPrice.Timestamp
            };
        }
    }

    // Ammo packs need full items.json metadata; skip when LFS download was unavailable
    if (sptItems)
    {
        const ammoPacks = Object.values(sptItems)
            .filter(x => (x._parent === "5661632d4bdc2d903d8b456b" || x._parent === "543be5cb4bdc2deb348b4568")
                && (x._name.includes("item_ammo_box_") || x._name.includes("ammo_box_"))
                && !x._name.includes("_damaged"));

        for (const ammoPack of ammoPacks)
        {
            if (!priceList[ammoPack._id])
            {
                if (DEBUG) console.info(`[${gameMode}] edge case ammo pack ${ammoPack._id} ${ammoPack._name} not found in prices, adding manually`);
                const itemMultipler = ammoPack._props.StackSlots[0]._max_count;
                const singleItemPrice = getItemPrice(priceList, sptHandbook.Items, ammoPack._props.StackSlots[0]._props.filters[0].Filter[0]);
                const price = singleItemPrice * itemMultipler;

                priceList[ammoPack._id] = {
                    priceMin: price,
                    price: price,
                    offerCount: 0,
                    timestamp: 0
                };
            }
        }
    }
    else
    {
        console.warn(`[${gameMode}] items.json unavailable — skipping ammo pack edge-case pricing`);
    }

    // Write out the updated price data
    fs.writeFileSync(`prices-${gameMode}.json`, JSON.stringify(priceList, null, 4));
});

const fetchCurrentPriceData = (async (gameMode, filteredTarkovDevPrices) => {
    const existingPrices = readExistingPrices(gameMode);
    const itemIdsToFetch = Object.entries(filteredTarkovDevPrices)
        .filter(([itemId, itemPrice]) => itemPrice.PriceMin && itemPrice.Price && existingPrices[itemId]?.timestamp !== itemPrice.Timestamp)
        .map(([itemId]) => itemId);
    const currentPriceData = {};
    let itemIndex = 0;

    for (const itemId in filteredTarkovDevPrices)
    {
        if (existingPrices[itemId])
        {
            currentPriceData[itemId] = {
                Name: filteredTarkovDevPrices[itemId].Name,
                PriceMin: existingPrices[itemId].priceMin,
                Price: existingPrices[itemId].price,
                OfferCount: existingPrices[itemId].offerCount ?? 0,
                Timestamp: existingPrices[itemId].timestamp ?? 0,
                TemplateId: itemId
            };
        }
    }

    if (itemIdsToFetch.length === 0)
    {
        return currentPriceData;
    }

    console.log(`[${gameMode}] Fetching exact current price snapshots for ${itemIdsToFetch.length} changed items`);

    const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, itemIdsToFetch.length) }, async () => {
        while (itemIndex < itemIdsToFetch.length)
        {
            const itemId = itemIdsToFetch[itemIndex++];
            const livePrice = await fetchLatestItemPrice(gameMode, itemId);
            if (!livePrice)
            {
                continue;
            }

            currentPriceData[itemId] = {
                Name: filteredTarkovDevPrices[itemId].Name,
                PriceMin: livePrice.priceMin,
                Price: livePrice.price,
                OfferCount: livePrice.offerCount ?? filteredTarkovDevPrices[itemId].OfferCount,
                Timestamp: livePrice.timestamp,
                TemplateId: itemId
            };
        }
    });

    await Promise.all(workers);

    return currentPriceData;
});

const fetchLatestItemPrice = (async (gameMode, itemId) => {
    try
    {
        const response = await fetch(`https://json.tarkov.dev/${gameMode}/prices/${itemId}`);
        if (!response.ok)
        {
            if (DEBUG) console.warn(`[${gameMode}] Failed to fetch price snapshot for ${itemId}: ${response.status} ${response.statusText}`);
            return undefined;
        }

        const data = await response.json();

        // API may return a direct snapshot object or a { data: [...] } history array — handle both
        let latest;
        if (data?.priceMin || data?.price)
        {
            latest = data;
        }
        else if (Array.isArray(data?.data))
        {
            latest = data.data.at(-1);
        }

        if (!latest?.priceMin || !latest?.price)
        {
            return undefined;
        }

        return latest;
    }
    catch (error)
    {
        if (DEBUG) console.warn(`[${gameMode}] Error fetching price snapshot for ${itemId}: ${error}`);
        return undefined;
    }
});

const readExistingPrices = ((gameMode) => {
    const pricePath = `prices-${gameMode}.json`;
    if (!fs.existsSync(pricePath))
    {
        return {};
    }

    const existingPrices = JSON.parse(fs.readFileSync(pricePath, 'utf-8'));
    const normalizedPrices = {};

    for (const itemId in existingPrices)
    {
        const itemPrice = existingPrices[itemId];
        if (typeof itemPrice === 'number')
        {
            normalizedPrices[itemId] = {
                priceMin: itemPrice,
                price: itemPrice,
                offerCount: 0,
                timestamp: 0
            };
        }
        else if (itemPrice?.price)
        {
            normalizedPrices[itemId] = itemPrice;
        }
    }

    return normalizedPrices;
});

const processTarkovDevItems = ((gameMode, tarkovDevItems) => {
    const filteredTarkovDevPrices = {};
    const tarkovItems = tarkovDevItems.data?.items ?? {};

    for (const item of Object.values(tarkovItems))
    {
        if (item.changeLast48hPercent > 100)
        {
            console.warn(`[${gameMode}] Item ${item.id} ${item.name} Has had recent ${item.changeLast48hPercent}% increase in price`);
        }

        if (item.name.indexOf(" (0/") >= 0)
        {
            if (DEBUG) console.warn(`[${gameMode}] Skipping 0 durability item: ${item.id} ${item.name}`);
            continue;
        }

        filteredTarkovDevPrices[item.id] = {
            Name: item.name,
            PriceMin: item.lastLowPrice,
            Price: item.avg24hPrice,
            OfferCount: item.lastOfferCount ?? 0,
            Timestamp: item.updated ? Date.parse(item.updated) : 0,
            TemplateId: item.id
        };
    }

    return filteredTarkovDevPrices;
});

const getItemPrice = ((priceList, handbookItems, itemTpl) => {
    const fleaPrice = priceList[itemTpl]?.price ?? priceList[itemTpl];
    if (!fleaPrice)
    {
        return handbookItems.find(x => x.Id === itemTpl).Price;
    }
    return fleaPrice;
});

const isLfsPointer = ((content) => content.trimStart().startsWith('version https://git-lfs.github.com/spec/v1'));

const readJsonFile = ((filename, { optional = false } = {}) => {
    if (!fs.existsSync(filename))
    {
        if (optional)
        {
            return undefined;
        }

        throw new Error(`Missing required file: ${filename}`);
    }

    const content = fs.readFileSync(filename, 'utf-8');
    if (isLfsPointer(content))
    {
        throw new Error(`${filename} is a Git LFS pointer, not JSON. Delete it and rerun the fetcher.`);
    }

    try
    {
        return JSON.parse(content);
    }
    catch (error)
    {
        throw new Error(`Failed to parse ${filename}: ${error.message}`);
    }
});

const downloadFile = (async (url, filename) => {
    const response = await fetch(url);
    if (!response.ok)
    {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
    if (isLfsPointer(content))
    {
        throw new Error(`${filename} is stored in Git LFS at ${url} and cannot be fetched via raw.githubusercontent.com`);
    }

    fs.writeFileSync(filename, content);
});

/**
 * SPT stores items.json (~19 MB) in custom Git LFS, not as a plain raw GitHub file.
 * Try a sparse clone + git lfs pull first; continue without items.json if LFS is unavailable.
 */
const downloadItemsJson = (async () => {
    if (fs.existsSync('items.json'))
    {
        try
        {
            readJsonFile('items.json');
            console.log('Using cached items.json');
            return;
        }
        catch (error)
        {
            console.warn(`Cached items.json is invalid (${error.message}); re-downloading...`);
            fs.unlinkSync('items.json');
        }
    }

    // Raw GitHub URL always returns an LFS pointer for this file — skip straight to git lfs.
    console.log('Fetching items.json via sparse git clone + Git LFS...');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spt-items-'));
    const lfsEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' };
    try
    {
        execSync('git lfs install', { stdio: 'inherit' });
        execSync(`git clone --depth 1 --filter=blob:none --sparse "${SPT_REPO}" "${tempDir}"`, { stdio: 'inherit', env: lfsEnv });
        execSync(`git sparse-checkout set --no-cone "/${SPT_ITEMS_PATH}"`, { cwd: tempDir, stdio: 'inherit', env: lfsEnv });
        execSync('git lfs pull', { cwd: tempDir, stdio: 'inherit' });

        const sourcePath = path.join(tempDir, SPT_ITEMS_PATH);
        if (!fs.existsSync(sourcePath))
        {
            throw new Error(`Git LFS checkout completed but ${SPT_ITEMS_PATH} was not found`);
        }

        fs.copyFileSync(sourcePath, 'items.json');
        readJsonFile('items.json');
        console.log('items.json downloaded successfully via Git LFS');
    }
    catch (error)
    {
        console.warn(`Could not download items.json via Git LFS (${error.message})`);
        console.warn('Continuing with sptprices.json item IDs only — ammo pack edge-case pricing will be skipped');
    }
    finally
    {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// Trigger main
await main();
