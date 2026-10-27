import React from "react";
import { modelBrandKey } from "../lib/model-brand";
import { BrandMark } from "./BrandMark";

/**
 * The vendor mark behind a model choice, so every model dropdown draws brands
 * one way (the same registry the Connections cards and engine pickers use).
 */
export function ModelMark({
  id,
  provider,
  size = 15,
}: {
  id: string;
  provider?: string;
  size?: number;
}) {
  const key = modelBrandKey(id, provider);
  return key ? <BrandMark name={key} size={size} /> : null;
}
