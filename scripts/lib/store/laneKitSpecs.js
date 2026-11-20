// A --table-specs module for the CLI test (laneCli.test.js): the lane kit's JSON table for every coin.
import { specsOf } from "./laneKit.js";

export const tableSpecsFor = (slug) => specsOf(slug);
