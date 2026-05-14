-- =============================================================================
-- Menú Resto Illimani → public.menu_items
-- Ejecutá en Supabase → SQL Editor (rol postgres / service role bypass RLS).
--
-- Resuelve el restaurante por nombre o public_name que contenga "illimani".
-- Si ya insertaste antes y querés repetir: borrá las filas de ese restaurante
-- o comentá los INSERT y usá solo DELETE + INSERT.
-- =============================================================================

with r as (
  select id
  from public.restaurants
  where lower(coalesce(name, '')) like '%illimani%'
     or lower(coalesce(public_name, '')) like '%illimani%'
  order by id
  limit 1
),
ins (name, description, category, price, available) as (
  values
    ('Ají de lengua', null::text, 'Platos especiales'::text, 15000::numeric, true),
    ('Picante de pollo', null, 'Platos especiales', 18000, true),
    ('Falso conejo', null, 'Platos especiales', 14000, true),
    ('Pique a lo macho (1 persona)', null, 'Platos especiales', 17000, true),
    ('Lomo salteado', null, 'Platos especiales', 12000, true),
    ('Costeleta de carne (1 persona)', null, 'Platos especiales', 16000, true),
    ('Costeleta de carne (2 personas)', null, 'Platos especiales', 25000, true),
    ('Costeleta de cerdo (1 persona)', null, 'Platos especiales', 12000, true),
    ('Napolitana (1 persona)', null, 'Platos principales', 18000, true),
    ('Chicharrón (1 persona)', null, 'Platos principales', 18000, true),
    ('Empanadas de carne (1 docena)', null, 'Empanadas', 12000, true),
    ('Empanadas de carne (media docena)', null, 'Empanadas', 7000, true),
    ('Empanadas de pollo (1 docena)', null, 'Empanadas', 12000, true),
    ('Empanadas de pollo (media docena)', null, 'Empanadas', 7000, true),
    (
      'Pique a lo macho (2 personas)',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).'::text,
      'Platos especiales',
      0::numeric,
      false
    ),
    (
      'Fricasé',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos especiales',
      0,
      false
    ),
    (
      'Carne a la olla',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos especiales',
      0,
      false
    ),
    (
      'Cerdo al horno',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos especiales',
      0,
      false
    ),
    (
      'La planchita',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos especiales',
      0,
      false
    ),
    (
      'Silpancho',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos especiales',
      0,
      false
    ),
    (
      'Mondongo chuquisaqueño',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos especiales',
      0,
      false
    ),
    (
      'Filet de merluza',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos especiales',
      0,
      false
    ),
    (
      'Napolitana (2 personas)',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos principales',
      0,
      false
    ),
    (
      'Chicharrón (2 personas)',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Platos principales',
      0,
      false
    ),
    (
      'Ravioles',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Pastas',
      0,
      false
    ),
    (
      'Ñoquis',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Pastas',
      0,
      false
    ),
    (
      'Tallarines',
      'Precio a confirmar en el local (no figuraba en la carta fotografiada).',
      'Pastas',
      0,
      false
    )
)
insert into public.menu_items (restaurant_id, name, description, category, price, available)
select r.id, ins.name, ins.description, ins.category, ins.price, ins.available
from r
cross join ins
where exists (select 1 from r);

-- Si insertaste 0 filas: no hay restaurant con "illimani" en name/public_name.
-- Cambiá el WITH r por:
--   with r as (select 'TU_UUID_RESTAURANT'::uuid as id)
