-- Seed for integration tests. ~20 rows clustered around Charleville-Mézières
-- (lat 49.7724, lon 4.7203). Values are FICTIONAL but realistic in shape.
-- Coordinates spread within ~10km radius for spatial query coverage.

-- IMPORTANT: codes used here follow the real DREES FINESS nomenclature
-- (3-digit codes — see src/sante/finess-categories.ts FINESS_CATEGORIES).
-- 108 = CHU | 355 = CH | 354 = Hôpital privé | 295 = EPS | 109 = SSR
-- 500 = EHPAD | 501 = Maison de retraite | 502 = Logement-foyer
-- 603 = MSP   | 611 = Laboratoire | 620 = Pharmacie

INSERT INTO finess
  (num_finess, raison_sociale, categorie_code, categorie_libelle,
   num_voie, type_voie, voie, code_postal, code_insee, ville,
   telephone, email, date_ouverture, date_maj, geom)
VALUES
  -- 2 MCO inside 5km
  ('080000017', 'CH Charleville-Mézières', '355', 'Centre Hospitalier (CH)',
   '45', 'AVENUE', 'de Manchester', '08000', '08105', 'Charleville-Mézières',
   '0324583000', NULL, '1950-01-01', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7150, 49.7700), 4326)),
  ('080000025', 'Polyclinique du Parc', '354', 'Hôpital privé',
   '12', 'RUE', 'des Tilleuls', '08000', '08105', 'Charleville-Mézières',
   '0324567890', NULL, '1985-06-15', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7280, 49.7750), 4326)),

  -- 6 EHPAD inside 5km
  ('080000051', 'EHPAD Les Tilleuls', '500', 'EHPAD',
   '5', 'RUE', 'des Tilleuls', '08000', '08105', 'Charleville-Mézières',
   '0324111111', NULL, '1995-03-10', '2024-11-01',
   ST_SetSRID(ST_MakePoint(4.7100, 49.7680), 4326)),
  ('080000052', 'EHPAD Les Acacias', '500', 'EHPAD',
   '8', 'RUE', 'des Acacias', '08000', '08105', 'Charleville-Mézières',
   '0324222222', NULL, '2001-09-01', '2024-11-01',
   ST_SetSRID(ST_MakePoint(4.7220, 49.7720), 4326)),
  ('080000053', 'EHPAD Soleil Levant', '500', 'EHPAD',
   '14', 'AVENUE', 'du Soleil', '08000', '08105', 'Charleville-Mézières',
   '0324333333', NULL, '2010-04-20', '2024-11-01',
   ST_SetSRID(ST_MakePoint(4.7050, 49.7800), 4326)),
  ('080000054', 'EHPAD Bel Horizon', '500', 'EHPAD',
   '22', 'RUE', 'du Bel Horizon', '08000', '08105', 'Charleville-Mézières',
   '0324444444', NULL, '2015-07-15', '2024-11-01',
   ST_SetSRID(ST_MakePoint(4.7350, 49.7600), 4326)),
  ('080000055', 'Maison de retraite La Roseraie', '501', 'Maison de retraite',
   '3', 'RUE', 'de la Roseraie', '08000', '08105', 'Charleville-Mézières',
   '0324555555', NULL, '2018-02-01', '2024-11-01',
   ST_SetSRID(ST_MakePoint(4.7000, 49.7650), 4326)),
  ('080000056', 'Logement-foyer Les Glycines', '502', 'Logement-foyer',
   '17', 'RUE', 'des Glycines', '08000', '08105', 'Charleville-Mézières',
   '0324666666', NULL, '2020-10-01', '2024-11-01',
   ST_SetSRID(ST_MakePoint(4.7400, 49.7780), 4326)),

  -- 3 SSR inside 5km
  ('080000071', 'SSR Centre Cardiologique', '109', 'SSR',
   '1', 'AVENUE', 'des Soignants', '08000', '08105', 'Charleville-Mézières',
   '0324777777', NULL, '2005-05-12', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7180, 49.7740), 4326)),
  ('080000072', 'SSR Pneumologie', '109', 'SSR',
   '4', 'RUE', 'du Repos', '08000', '08105', 'Charleville-Mézières',
   '0324888888', NULL, '2008-11-01', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7250, 49.7790), 4326)),
  ('080000073', 'SSR Polyvalent', '109', 'SSR',
   '9', 'RUE', 'de la Convalescence', '08000', '08105', 'Charleville-Mézières',
   '0324999999', NULL, '2012-03-01', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7120, 49.7660), 4326)),

  -- 2 "autre" inside 5km (unrelated category)
  ('080000091', 'Laboratoire d''analyses', '611', 'Laboratoire d''analyses de biologie médicale',
   '6', 'AVENUE', 'du Rein', '08000', '08105', 'Charleville-Mézières',
   '0324101010', NULL, '2007-06-15', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7290, 49.7710), 4326)),
  ('080000092', 'Maison de Santé', '603', 'Maison de Santé Pluri-pro (MSP)',
   '11', 'RUE', 'du Médecin', '08000', '08105', 'Charleville-Mézières',
   '0324202020', NULL, '2019-01-01', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7160, 49.7730), 4326)),

  -- 4 outside the 5km radius (test exclusion)
  ('080000101', 'EHPAD Sedan', '500', 'EHPAD',
   '20', 'RUE', 'Principale', '08200', '08409', 'Sedan',
   '0324111000', NULL, '2000-01-01', '2024-11-01',
   ST_SetSRID(ST_MakePoint(4.9450, 49.7050), 4326)),
  ('080000102', 'CH Sedan', '355', 'Centre Hospitalier (CH)',
   '15', 'AVENUE', 'de Verdun', '08200', '08409', 'Sedan',
   '0324112000', NULL, '1955-01-01', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.9420, 49.7080), 4326)),
  ('080000103', 'CHU Reims', '108', 'Centre Hospitalier Universitaire (CHU)',
   '45', 'RUE', 'Cognacq-Jay', '51100', '51454', 'Reims',
   '0326787878', NULL, '1900-01-01', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.0310, 49.2580), 4326)),
  ('080000104', 'EHPAD Mézières', '500', 'EHPAD',
   '7', 'RUE', 'des Champs', '08160', '08400', 'Mézières-sur-Issoire',
   '0324113000', NULL, '2003-05-01', '2024-11-01',
   ST_SetSRID(ST_MakePoint(0.7500, 46.1500), 4326)),

  -- 1 with unknown category code (edge case for finessFamille → "autre")
  ('080000201', 'Établissement Test', '9999', 'Catégorie Inconnue',
   '1', 'RUE', 'du Test', '08000', '08105', 'Charleville-Mézières',
   '0324909090', NULL, '2024-01-01', '2024-12-01',
   ST_SetSRID(ST_MakePoint(4.7200, 49.7720), 4326)),

  -- 1 row with NULL geom (edge case)
  ('080000202', 'Établissement Sans Coords', '500', 'EHPAD',
   '99', 'RUE', 'Mystère', '08000', '08105', 'Charleville-Mézières',
   NULL, NULL, '2020-01-01', '2024-11-01', NULL);
