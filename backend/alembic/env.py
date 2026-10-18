from logging.config import fileConfig

from alembic import context
from sqlalchemy import text

from app import models  # noqa: F401  (registers tables on Base.metadata)
from app.db import Base, engine

if context.config.config_file_name:
    fileConfig(context.config.config_file_name)

target_metadata = Base.metadata


def run_migrations_online():
    with engine.connect() as conn:
        is_mysql = conn.dialect.name == "mysql"
        # Several API containers start at once on deploy; a MySQL named lock
        # makes sure only one of them runs the migrations.
        if is_mysql:
            conn.execute(text("SELECT GET_LOCK('dispatchx_migrations', 120)"))
            conn.commit()  # named locks are session-scoped; end the autobegun txn
        try:
            context.configure(connection=conn, target_metadata=target_metadata, compare_type=True)
            with context.begin_transaction():
                context.run_migrations()
            conn.commit()
        finally:
            if is_mysql:
                conn.execute(text("SELECT RELEASE_LOCK('dispatchx_migrations')"))


run_migrations_online()
