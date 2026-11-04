import { toast } from 'svelte-sonner';
import { evaluateDiceRoll } from './rolling';
import DiceRoll from './DiceRoll.svelte';
import { rollInfluence } from './influence.svelte';
import { owlbear } from '$lib/owlbear.svelte';
import { id } from '$lib/random';
import { sendBusDiceRoll } from '$lib/bus-roll';
import { rollHistory } from './history';
import { isDicePlusReady, rollWithDicePlus, type DicePlusResult } from './dice-plus';

type RollOptions = {
	label?: string;
	context?: Record<string, number>;
	rollModifier?: number;
	characterName?: string;
	forceLocal?: boolean;
	showDicePlusResults?: boolean;
	rollTarget?: 'everyone' | 'self' | 'dm' | 'gm_only';
};

/**
 * Convert a Nimblesheet-style formula into something closer to standard dice notation
 * that Dice+ understands. This is a best-effort translator.
 * - Substitutes [KEY] context values
 * - Leaves exploding ! in place (Dice+ supports it)
 * - Strips or approximates vicious/influence if needed
 */
function prepareNotationForDicePlus(
	formula: string,
	context: Record<string, number> = {},
	rollModifier = 0,
	label?: string
): string {
	let expr = formula;

	// Substitute context keys like [STR]
	expr = expr.replace(/\[([^\]]+)\]/g, (_, key) => {
		if (key in context) return String(context[key]);
		return '0';
	});

	// Basic cleanup
	expr = expr.replace(/\s+/g, ' ').trim();

	// Apply simple flat modifier if present (Dice+ will evaluate it)
	if (rollModifier) {
		expr = rollModifier > 0 ? `${expr}+${rollModifier}` : `${expr}${rollModifier}`;
	}

	if (label && !expr.includes('#')) {
		expr = `${expr} # ${label}`;
	}

	return expr;
}

function dicePlusResultToLegacy(result: DicePlusResult, originalFormula: string) {
	// Minimal adapter so existing toast/history that expect NimbleRoll still work.
	// You can expand this to map groups more faithfully.
	return {
		formula: originalFormula,
		value: result.totalValue,
		dice: result.groups.flatMap((g) =>
			g.dice.map((d) => ({
				sides: parseInt(g.diceType.replace(/\D/g, '') || '6', 10),
				value: d.value,
				type: d.kept ? 'normal' : 'dropped',
				isMax: false,
				isMin: false,
			}))
		),
		isCrit: false,
		isMiss: false,
		summary: result.rollSummary,
	};
}

export async function rollDice(
	formula: string,
	{
		label,
		context = {},
		rollModifier,
		characterName,
		forceLocal = false,
		showDicePlusResults = true,
		rollTarget = 'everyone',
	}: RollOptions = {}
) {
	rollModifier = (rollModifier ?? 0) + rollInfluence.value;

	let usedDicePlus = false;
	let result: any;

	// Prefer Dice+ when embedded in Owlbear and Dice+ is present
	if (!forceLocal && owlbear.embedded && (await isDicePlusReady())) {
		try {
			const notation = prepareNotationForDicePlus(formula, context, rollModifier, label);
			const dpResult = await rollWithDicePlus(notation, {
				label,
				showResults: showDicePlusResults,
				rollTarget,
			});
			result = dicePlusResultToLegacy(dpResult, formula);
			usedDicePlus = true;
		} catch (err) {
			console.warn('[Nimblesheet] Dice+ roll failed, falling back to local roller', err);
		}
	}

	if (!usedDicePlus) {
		// Original local path
		result = await evaluateDiceRoll(formula, context, rollModifier, rollInfluence.primary);
	}

	toast(DiceRoll, {
		componentProps: {
			formula,
			label,
			rollModifier,
			result,
			primaryoffset: rollInfluence.primary,
		},
		class:
			'[--initial-height:7.5rem]! bg-gray-200! dark:bg-gray-800! dark:text-white! border-gray-400!',
	});

	const rollId = id();
	await rollHistory.add({
		id: rollId,
		rolledAt: new Date().toISOString(),
		formula,
		label,
		characterName,
		result,
	});

	// Keep existing Owlbear/DiceLog broadcast for compatibility (optional — you can remove later)
	if (!usedDicePlus) {
		await owlbear.sendDiceRoll(result, rollId, label, characterName, rollModifier);
		await sendBusDiceRoll(result, rollId, label, characterName, rollModifier);
	}

	rollInfluence.reset();
	return result;
}
