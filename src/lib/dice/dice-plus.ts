import OBR from '@owlbear-rodeo/sdk';

const SOURCE = 'nimblesheet';
const READY_CHANNEL = 'dice-plus/isReady';
const VALIDATE_CHANNEL = 'dice-plus/validate-notation';
const ROLL_CHANNEL = 'dice-plus/roll-request';
const RESULT_CHANNEL = `${SOURCE}/roll-result`;
const ERROR_CHANNEL = `${SOURCE}/roll-error`;

export type DicePlusRollOptions = {
	label?: string;
	showResults?: boolean;
	rollTarget?: 'everyone' | 'self' | 'dm' | 'gm_only';
	timeoutMs?: number;
};

export type DicePlusResult = {
	rollId: string;
	diceNotation: string;
	totalValue: number;
	rollSummary: string;
	groups: Array<{
		description?: string;
		diceModel?: string;
		diceType: string;
		dice: Array<{ value: number; kept: boolean; diceId?: string }>;
		total: number;
		isNegative?: boolean;
		isCondensed?: boolean;
		condensedCount?: number;
	}>;
};

type ReadyResponse = { requestId: string; ready: true; timestamp: number };
type ValidateResponse = {
	requestId: string;
	notation: string;
	valid: boolean;
	error?: { message: string; position: number };
	timestamp: number;
};
type ResultMessage = {
	rollId: string;
	playerId: string;
	playerName: string;
	rollTarget: string;
	timestamp: number;
	result: DicePlusResult;
};
type ErrorMessage = { rollId: string; error: string; notation: string };

function onceWithTimeout<T>(
	channel: string,
	predicate: (data: any) => boolean,
	timeoutMs: number
): Promise<T> {
	return new Promise((resolve, reject) => {
		const unsubscribe = OBR.broadcast.onMessage(channel, (event) => {
			if (predicate(event.data)) {
				cleanup();
				resolve(event.data as T);
			}
		});

		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Dice+ timed out on channel ${channel}`));
		}, timeoutMs);

		function cleanup() {
			clearTimeout(timer);
			unsubscribe();
		}
	});
}

export async function isDicePlusReady(timeoutMs = 1200): Promise<boolean> {
	if (!OBR.isAvailable) return false;

	try {
		const requestId = crypto.randomUUID();
		const promise = onceWithTimeout<ReadyResponse>(
			READY_CHANNEL,
			(data) => data && 'ready' in data && data.requestId === requestId,
			timeoutMs
		);

		await OBR.broadcast.sendMessage(
			READY_CHANNEL,
			{ requestId, timestamp: Date.now() },
			{ destination: 'ALL' }
		);

		const res = await promise;
		return !!res.ready;
	} catch {
		return false;
	}
}

export async function validateNotation(notation: string, timeoutMs = 1000): Promise<{ valid: boolean; error?: string }> {
	if (!OBR.isAvailable) return { valid: false, error: 'Not inside Owlbear' };

	const requestId = crypto.randomUUID();
	const promise = onceWithTimeout<ValidateResponse>(
		VALIDATE_CHANNEL,
		(data) => data && 'valid' in data && data.requestId === requestId,
		timeoutMs
	);

	await OBR.broadcast.sendMessage(
		VALIDATE_CHANNEL,
		{ requestId, notation, timestamp: Date.now() },
		{ destination: 'ALL' }
	);

	try {
		const res = await promise;
		return { valid: res.valid, error: res.error?.message };
	} catch (e) {
		return { valid: false, error: e instanceof Error ? e.message : 'Validation failed' };
	}
}

export async function rollWithDicePlus(
	diceNotation: string,
	options: DicePlusRollOptions = {}
): Promise<DicePlusResult> {
	if (!OBR.isAvailable) {
		throw new Error('Dice+ integration requires Owlbear Rodeo');
	}

	const ready = await isDicePlusReady();
	if (!ready) {
		throw new Error('Dice+ is not available or not ready');
	}

	const rollId = `roll_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	const timeoutMs = options.timeoutMs ?? 15000;

	const resultPromise = onceWithTimeout<ResultMessage>(
		RESULT_CHANNEL,
		(data) => data?.rollId === rollId,
		timeoutMs
	);

	const errorPromise = onceWithTimeout<ErrorMessage>(
		ERROR_CHANNEL,
		(data) => data?.rollId === rollId,
		timeoutMs
	).then((err) => {
		throw new Error(err.error || 'Dice+ roll failed');
	});

	const playerId = await OBR.player.getId();
	const playerName = await OBR.player.getName();

	// Attach label as a # group if provided and not already present
	let notation = diceNotation.trim();
	if (options.label && !notation.includes('#')) {
		notation = `${notation} # ${options.label}`;
	}

	await OBR.broadcast.sendMessage(
		ROLL_CHANNEL,
		{
			rollId,
			playerId,
			playerName,
			rollTarget: options.rollTarget ?? 'everyone',
			diceNotation: notation,
			showResults: options.showResults ?? true,
			timestamp: Date.now(),
			source: SOURCE,
		},
		{ destination: 'ALL' }
	);

	const message = await Promise.race([resultPromise, errorPromise]);
	return (message as ResultMessage).result;
}
