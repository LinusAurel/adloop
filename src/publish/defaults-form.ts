import type { AdvertiserDefaults } from "./settings";

/** Fields the Vorgaben form is allowed to edit. */
export type DefaultsFormPatch = {
  pageId: string;
  instagramActorId: string;
  beneficiaryName: string;
  payerName: string;
  optimizationGoal: string;
  budgetMode: "CBO" | "ABO";
  countries: string;
  websiteUrl: string;
  utmParams: string;
  creativeTemplate: string;
  adSetTemplate: string;
  adTemplate: string;
};

/**
 * Apply only form-visible fields onto loaded defaults. Undisplayed
 * targeting / placement / attribution values stay untouched.
 */
export function mergeDefaultsFormPatch(
  base: AdvertiserDefaults,
  form: DefaultsFormPatch,
): AdvertiserDefaults {
  return {
    ...base,
    identity: {
      ...base.identity,
      pageId: form.pageId,
      ...(form.instagramActorId.trim()
        ? { instagramActorId: form.instagramActorId.trim() }
        : { instagramActorId: undefined }),
      ...(form.beneficiaryName.trim()
        ? { beneficiaryName: form.beneficiaryName.trim() }
        : { beneficiaryName: undefined }),
      ...(form.payerName.trim()
        ? { payerName: form.payerName.trim() }
        : { payerName: undefined }),
    },
    adSet: {
      ...base.adSet,
      optimizationGoal:
        form.optimizationGoal as AdvertiserDefaults["adSet"]["optimizationGoal"],
      budgetMode: form.budgetMode,
      targeting: {
        ...base.adSet.targeting,
        countries: form.countries
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      },
    },
    website: {
      ...base.website,
      url: form.websiteUrl,
      utmParams: form.utmParams,
    },
    autoNaming: {
      ...base.autoNaming,
      creativeTemplate: form.creativeTemplate,
      adSetTemplate: form.adSetTemplate,
      adTemplate: form.adTemplate,
    },
  };
}
