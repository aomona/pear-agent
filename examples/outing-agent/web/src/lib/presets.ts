import {
  createEmptyBelongingRow,
  createEmptyTaskRow,
  defaultDepartureLocal,
  type OutingFormState,
} from "./build-outing-input";

export type OutingPresetId = "commute" | "trip" | "gym";

export type OutingPreset = {
  id: OutingPresetId;
  label: string;
  description: string;
  apply: () => OutingFormState;
};

/** One-tap starters so the input phase is never empty. */
export const OUTING_PRESETS: OutingPreset[] = [
  {
    id: "commute",
    label: "通勤",
    description: "家→会社 · 鍵/スマホ · 天気予報",
    apply: () => ({
      departureMode: "structured",
      departureLocal: defaultDepartureLocal(),
      departureFreeText: "tomorrow 8:30am",
      originLabel: "Home",
      destinationLabel: "Office",
      items: [
        createEmptyBelongingRow({ id: "keys", name: "Keys", chargePercent: "" }),
        createEmptyBelongingRow({ id: "phone", name: "Phone", chargePercent: "25" }),
        createEmptyBelongingRow({ id: "wallet", name: "Wallet", chargePercent: "" }),
        createEmptyTaskRow({
          id: "weather",
          title: "Check weather",
          estimatedDurationSeconds: "30",
          notes: "",
        }),
        createEmptyTaskRow({
          id: "lock",
          title: "Lock the door",
          estimatedDurationSeconds: "20",
          notes: "",
        }),
      ],
    }),
  },
  {
    id: "trip",
    label: "旅行",
    description: "家→駅 · 充電器多め · 荷物確認",
    apply: () => ({
      departureMode: "structured",
      departureLocal: defaultDepartureLocal(),
      departureFreeText: "Saturday 7am",
      originLabel: "Home",
      destinationLabel: "Station",
      items: [
        createEmptyBelongingRow({ id: "passport", name: "Passport", chargePercent: "" }),
        createEmptyBelongingRow({ id: "phone", name: "Phone", chargePercent: "40" }),
        createEmptyBelongingRow({ id: "charger", name: "Charger", chargePercent: "" }),
        createEmptyBelongingRow({ id: "earbuds", name: "Earbuds", chargePercent: "60" }),
        createEmptyTaskRow({
          id: "tickets",
          title: "Check tickets",
          estimatedDurationSeconds: "60",
          notes: "App boarding pass",
        }),
        createEmptyTaskRow({
          id: "trash",
          title: "Take out trash",
          estimatedDurationSeconds: "120",
          notes: "",
        }),
      ],
    }),
  },
  {
    id: "gym",
    label: "ジム",
    description: "家→ジム · ボトル/ウェア · ロッカー",
    apply: () => ({
      departureMode: "structured",
      departureLocal: defaultDepartureLocal(),
      departureFreeText: "this evening 6pm",
      originLabel: "Home",
      destinationLabel: "Gym",
      items: [
        createEmptyBelongingRow({ id: "water-bottle", name: "Water bottle", chargePercent: "" }),
        createEmptyBelongingRow({ id: "shoes", name: "Training shoes", chargePercent: "" }),
        createEmptyBelongingRow({ id: "phone", name: "Phone", chargePercent: "50" }),
        createEmptyTaskRow({
          id: "locker",
          title: "Pack locker bag",
          estimatedDurationSeconds: "90",
          notes: "Towel + clothes",
        }),
      ],
    }),
  },
];
