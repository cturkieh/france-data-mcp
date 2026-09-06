// Branche FERMETURE de l'émetteur unique d'issues ops (`upsert-ops-issue`).
//
// Vit dans un fichier À PART, en CommonJS, pour DEUX raisons :
//  1. testable HORS GitHub Actions (`scripts/ingest/close-ops-issue.test.ts`
//     l'appelle avec un octokit factice) — la logique d'un canal d'alerte ne
//     doit pas être vérifiable seulement par assertions textuelles sur du YAML ;
//  2. `actions/github-script` charge un fichier externe par `require`, et exige
//     du CommonJS (aucune transpilation dans le runner).
//
// BEST-EFFORT PAR CONTRAT (doctrine `send-ops-email` / `upsert-ops-issue`) : la
// fermeture est un CONFORT (le drain a déjà réussi). Toute panne = log LOUD
// (`core.warning` → annotation `::warning::` + console) et `outcome = failed` —
// JAMAIS un throw, JAMAIS un run rouge. L'issue non fermée sera reprise au
// drain suivant (idempotent : elle est toujours ouverte, toujours labellisée).
//
// SÉCURITÉ DU FILTRE : sans labels, `listForRepo` renverrait TOUTES les issues
// ouvertes du dépôt — on fermerait le dépôt entier. Labels vides = refus net.

/**
 * Ferme les issues OUVERTES portant TOUS les labels donnés (sémantique ET de
 * l'API GitHub — la MÊME que celle qui sert de clé d'idempotence à l'ouverture,
 * pour que « ce qu'une source ouvre, son drain le referme » soit vrai même si
 * un humain a ajouté un label à l'issue).
 *
 * @param {object} args
 * @param {{rest: {issues: {listForRepo: Function, createComment: Function, update: Function}}}} args.github Client octokit (fourni par `actions/github-script`).
 * @param {{repo: {owner: string, repo: string}}} args.context Contexte du run.
 * @param {{info: Function, warning: Function, error: Function}} args.core Boîte à outils d'annotations.
 * @param {string[]} args.labels Labels (clé d'idempotence). VIDE = refus.
 * @param {string} args.comment Commentaire posté AVANT la fermeture (traçabilité).
 * @param {string} args.runUrl URL du run (repli quand le commentaire est vide).
 * @returns {Promise<"closed"|"absent"|"failed">} `absent` = rien d'ouvert à fermer (cas nominal le plus fréquent).
 */
async function closeOpsIssue({ github, context, core, labels, comment, runUrl }) {
  const url = runUrl || "(run inconnu)";
  if (!Array.isArray(labels) || labels.length === 0) {
    // Fermer sans filtre = fermer tout le dépôt. Refus BRUYANT, jamais un repli.
    core.error(
      `close-ops-issue : labels VIDES (composition amont perdue) — AUCUNE fermeture (un filtre vide fermerait toutes les issues ouvertes). Run : ${url}`,
    );
    return "failed";
  }
  const body = comment || `✅ Fermeture automatique (corps manquant). Run : ${url}`;
  let closed = 0;
  try {
    const { data } = await github.rest.issues.listForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      state: "open",
      labels: labels.join(","),
      per_page: 100,
    });
    // `listForRepo` renvoie AUSSI les pull requests (même endpoint côté API) :
    // les écarter, une PR labellisée ne doit jamais être fermée par un cron.
    const issues = data.filter((i) => !i.pull_request);
    if (issues.length === 0) {
      core.info(
        `close-ops-issue : aucune issue ouverte [${labels.join(",")}] — rien à fermer (cas nominal).`,
      );
      return "absent";
    }
    for (const issue of issues) {
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        body,
      });
      await github.rest.issues.update({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        state: "closed",
        state_reason: "completed",
      });
      closed++;
      core.info(`close-ops-issue : issue #${issue.number} fermée [${labels.join(",")}].`);
    }
    return "closed";
  } catch (err) {
    // Best-effort : une panne de l'API issues ne re-rougit pas un drain réussi.
    const msg = `close-ops-issue : fermeture [${labels.join(",")}] échouée après ${closed} fermeture(s) (best-effort, l'issue sera reprise au prochain drain) : ${err instanceof Error ? err.message : String(err)}`;
    core.warning(msg);
    console.warn(msg);
    return "failed";
  }
}

module.exports = { closeOpsIssue };
