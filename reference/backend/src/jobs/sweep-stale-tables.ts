import "../config/env.js";
import { sweepStaleTables } from "../services/staleSweeper.js";

sweepStaleTables()
  .then(() => {
    console.log("[sweep] complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
