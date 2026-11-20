import importlib
import gc
import os
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


class FakeMT5Adapter:
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240
    COPY_TICKS_ALL = 0

    def __init__(self):
        self.calls = []
        self.rates = []
        self.ticks = []
        self.login = 12345

    def symbol_info(self, symbol):
        self.calls.append(("symbol_info", symbol))
        return SimpleNamespace(
            trade_mode=4,
            visible=True,
            point=0.00001,
            trade_tick_size=0.00001,
            trade_tick_value=1.0,
            trade_contract_size=100000.0,
            volume_min=0.01,
            volume_max=100.0,
            volume_step=0.01,
            trade_stops_level=0,
            trade_freeze_level=0,
            digits=5,
        )

    def terminal_info(self):
        return object()

    def account_info(self):
        return SimpleNamespace(
            login=self.login,
            server="Broker-Demo",
            currency="USD",
            balance=1000,
            equity=1000,
            margin_free=1000,
            trade_mode=0,
            leverage=100,
        )

    def copy_rates_range(self, symbol, timeframe, start, end):
        self.calls.append(("copy_rates_range", symbol, timeframe, start, end))
        return self.rates

    def copy_ticks_range(self, symbol, start, end, flags):
        self.calls.append(("copy_ticks_range", symbol, start, end, flags))
        return self.ticks

    def last_error(self):
        return "fake adapter error"


class TestServerTestDependencies(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_directory = tempfile.TemporaryDirectory()
        cls.original_localappdata = os.environ.get("LOCALAPPDATA")
        cls.original_database = os.environ.get("MT5_BRIDGE_STATE_DATABASE")
        os.environ["LOCALAPPDATA"] = cls.temp_directory.name
        os.environ["MT5_BRIDGE_STATE_DATABASE"] = os.path.join(
            cls.temp_directory.name, "test-state.sqlite3"
        )
        cls.server = importlib.import_module("server")
        cls.original_adapter = cls.server.mt5

    @classmethod
    def tearDownClass(cls):
        cls.server.configure_mt5_adapter(cls.original_adapter)
        if cls.original_localappdata is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = cls.original_localappdata
        if cls.original_database is None:
            os.environ.pop("MT5_BRIDGE_STATE_DATABASE", None)
        else:
            os.environ["MT5_BRIDGE_STATE_DATABASE"] = cls.original_database
        gc.collect()
        cls.temp_directory.cleanup()

    def test_fake_adapter_is_used_for_broker_calls(self):
        adapter = FakeMT5Adapter()
        self.server.configure_mt5_adapter(adapter)

        self.assertEqual(self.server.resolve_broker_symbol("XAUUSD"), "XAUUSD")
        self.assertEqual(adapter.calls, [("symbol_info", "XAUUSD")])

    def test_account_snapshot_includes_broker_currency(self):
        self.server.configure_mt5_adapter(FakeMT5Adapter())

        self.assertEqual(self.server.require_account()["currency"], "USD")

    def test_server_state_database_is_initialized_in_temporary_directory(self):
        self.assertTrue(self.server.STATE_DATABASE.is_relative_to(self.temp_directory.name))
        with closing(sqlite3.connect(self.server.STATE_DATABASE)) as connection, connection:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }

        self.assertIn("order_requests", tables)
        self.assertIn("control_state", tables)

    def test_kill_switch_state_survives_database_reinitialization(self):
        with closing(sqlite3.connect(self.server.STATE_DATABASE)) as connection, connection:
            connection.execute(
                "UPDATE control_state SET state_value = 'true' WHERE state_key = 'trading_halted'"
            )

        self.server.initialize_state_database()

        with closing(sqlite3.connect(self.server.STATE_DATABASE)) as connection:
            halted = connection.execute(
                "SELECT state_value FROM control_state WHERE state_key = 'trading_halted'"
            ).fetchone()[0]
        self.assertEqual(halted, "true")
        with closing(sqlite3.connect(self.server.STATE_DATABASE)) as connection, connection:
            connection.execute(
                "UPDATE control_state SET state_value = 'false' WHERE state_key = 'trading_halted'"
            )

    def test_disabling_circuit_breaker_does_not_disarm_kill_switch(self):
        self.server.configure_mt5_adapter(FakeMT5Adapter())
        with closing(sqlite3.connect(self.server.STATE_DATABASE)) as connection, connection:
            connection.execute(
                "UPDATE control_state SET state_value = 'true' WHERE state_key = 'trading_halted'"
            )
        request = SimpleNamespace(
            headers={},
            query_params={},
            client=SimpleNamespace(host="testclient"),
        )

        self.server.set_circuit_breaker_control(
            self.server.CircuitBreakerControlRequest(enabled=False),
            request,
        )

        with closing(sqlite3.connect(self.server.STATE_DATABASE)) as connection:
            halted = connection.execute(
                "SELECT state_value FROM control_state WHERE state_key = 'trading_halted'"
            ).fetchone()[0]
        self.assertEqual(halted, "true")
        with closing(sqlite3.connect(self.server.STATE_DATABASE)) as connection, connection:
            connection.execute(
                "UPDATE control_state SET state_value = 'false' WHERE state_key = 'trading_halted'"
            )
            connection.execute(
                "UPDATE control_state SET state_value = 'true' WHERE state_key = 'circuit_breaker_enabled'"
            )

    def test_execution_quote_validation_uses_executable_side_and_fails_closed(self):
        buy_price, spread = self.server.validate_execution_quote(
            SimpleNamespace(bid=1.1000, ask=1.1002), "BUY", 0.0001, 5, "EURUSD"
        )
        sell_price, _ = self.server.validate_execution_quote(
            SimpleNamespace(bid=1.1000, ask=1.1002), "SELL", 0.0001, 5, "EURUSD"
        )

        self.assertEqual((buy_price, sell_price), (1.1002, 1.1000))
        self.assertAlmostEqual(spread, 2.0)
        for invalid_tick in (
            None,
            SimpleNamespace(bid=0, ask=1.1002),
            SimpleNamespace(bid=1.1003, ask=1.1002),
            SimpleNamespace(bid=float("nan"), ask=1.1002),
        ):
            with self.subTest(tick=invalid_tick), self.assertRaises(self.server.HTTPException) as error:
                self.server.validate_execution_quote(invalid_tick, "BUY", 0.0001, 5, "EURUSD")
            self.assertEqual(error.exception.status_code, 503)

        with self.assertRaises(self.server.HTTPException) as error:
            self.server.validate_execution_quote(
                SimpleNamespace(bid=1.1000, ask=1.1006), "BUY", 0.0001, 5, "EURUSD"
            )
        self.assertEqual(error.exception.status_code, 423)

    def test_limit_price_never_falls_back_to_market_when_not_broker_valid(self):
        buy_limit = self.server.align_and_validate_limit_price(
            "BUY", 1.1002, 1.0990, 0.0001, 4, 0.0005
        )
        sell_limit = self.server.align_and_validate_limit_price(
            "SELL", 1.1000, 1.1010, 0.0001, 4, 0.0005
        )
        self.assertEqual((buy_limit, sell_limit), (1.099, 1.101))

        for direction, limit in (("BUY", 1.1000), ("SELL", 1.1004)):
            with self.subTest(direction=direction), self.assertRaises(self.server.HTTPException) as error:
                self.server.align_and_validate_limit_price(
                    direction, 1.1002, limit, 0.0001, 4, 0.0005
                )
            self.assertEqual(error.exception.status_code, 400)
            self.assertIn("no market order was substituted", error.exception.detail)

    def test_requested_stops_and_targets_are_validated_without_replacement(self):
        self.assertEqual(
            self.server.align_and_validate_order_levels(
                "BUY", 1.1000, 1.0990, 1.1020, 0.0001, 4, 0.0005
            ),
            (1.099, 1.102),
        )
        self.assertEqual(
            self.server.align_and_validate_order_levels(
                "SELL", 1.1000, 1.1010, 1.0980, 0.0001, 4, 0.0005
            ),
            (1.101, 1.098),
        )

        with self.assertRaises(self.server.HTTPException) as error:
            self.server.align_and_validate_order_levels(
                "BUY", 1.1000, 1.0999, 1.1020, 0.0001, 4, 0.0005
            )
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("stop loss", error.exception.detail)

    def test_research_candles_are_broker_sourced_and_only_include_closed_bars(self):
        adapter = FakeMT5Adapter()
        self.server.configure_mt5_adapter(adapter)
        now = int(time.time())
        adapter.rates = [
            {"time": now - 180, "open": 1.1, "high": 1.2, "low": 1.0, "close": 1.15,
             "tick_volume": 10, "spread": 2, "real_volume": 0},
            {"time": now - 30, "open": 1.1, "high": 1.2, "low": 1.0, "close": 1.15,
             "tick_volume": 10, "spread": 2, "real_volume": 0},
        ]
        request = SimpleNamespace(
            headers={},
            query_params={},
            client=SimpleNamespace(host="testclient"),
        )

        result = self.server.research_candles(
            request, "EURUSD", "M1", now - 300, now
        )

        self.assertEqual(result["source"], "MetaTrader5")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["candles"][0]["openTime"], now - 180)
        self.assertEqual(result["symbolSpec"]["digits"], 5)
        self.assertEqual(result["symbolSpec"]["tickSize"], 0.00001)
        self.assertEqual(adapter.calls[-1][0], "copy_rates_range")

    def test_research_ticks_returns_only_real_quotes_and_rejects_unsupported_adapter(self):
        adapter = FakeMT5Adapter()
        self.server.configure_mt5_adapter(adapter)
        now = int(time.time())
        adapter.ticks = [
            {"time_msc": (now - 2) * 1000, "bid": 1.1, "ask": 1.1002, "last": 0,
             "volume": 0, "flags": 6},
            {"time_msc": (now - 30) * 1000, "bid": 1.1, "ask": 1.1002, "last": 0,
             "volume": 0, "flags": 6},
        ]
        request = SimpleNamespace(
            headers={},
            query_params={},
            client=SimpleNamespace(host="testclient"),
        )

        result = self.server.research_ticks(request, "EURUSD", now - 10, now)

        self.assertEqual(result["source"], "MetaTrader5")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["ticks"][0]["bid"], 1.1)
        self.assertEqual(result["symbolSpec"]["volumeStep"], 0.01)
        self.assertEqual(adapter.calls[-1][0], "copy_ticks_range")

        adapter.COPY_TICKS_ALL = None
        with self.assertRaises(self.server.HTTPException) as error:
            self.server.research_ticks(request, "EURUSD", now - 10, now)
        self.assertEqual(error.exception.status_code, 501)

    def test_research_ticks_are_cached_per_account_and_limited_to_six_hour_chunks(self):
        adapter = FakeMT5Adapter()
        self.server.configure_mt5_adapter(adapter)
        now = int(time.time())
        adapter.ticks = [
            {"time_msc": (now - 15) * 1000, "bid": 1.1, "ask": 1.1002,
             "last": 0, "volume": 0, "flags": 6},
        ]
        request = SimpleNamespace(
            headers={},
            query_params={},
            client=SimpleNamespace(host="testclient"),
        )

        first = self.server.research_ticks(request, "EURUSD", now - 20, now - 10)
        second = self.server.research_ticks(request, "EURUSD", now - 20, now - 10)

        self.assertEqual(first, second)
        self.assertEqual(sum(call[0] == "copy_ticks_range" for call in adapter.calls), 1)
        adapter.login = 67890
        self.server.research_ticks(request, "EURUSD", now - 20, now - 10)
        self.assertEqual(sum(call[0] == "copy_ticks_range" for call in adapter.calls), 2)
        with self.assertRaises(self.server.HTTPException) as error:
            self.server.research_ticks(request, "EURUSD", now - 7 * 60 * 60, now)
        self.assertEqual(error.exception.status_code, 400)

    def test_calendar_cache_preserves_provider_fetch_time(self):
        request = SimpleNamespace(
            headers={},
            query_params={},
            client=SimpleNamespace(host="testclient"),
        )
        original_cache = self.server._economic_calendar_cache
        fetched_at = "2026-10-21T11:00:00+00:00"
        event_time = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        self.server._economic_calendar_cache = (
            time.monotonic(),
            "Forex Factory",
            [{
                "title": "CPI",
                "country": "USD",
                "date": event_time,
                "impact": "High",
                "forecast": "2.1%",
                "previous": "2.0%",
            }],
            fetched_at,
        )

        try:
            response = self.server.economic_calendar(request)
        finally:
            self.server._economic_calendar_cache = original_cache

        self.assertEqual(response["updatedAt"], fetched_at)
        self.assertEqual(response["source"], "Forex Factory")
        self.assertEqual(response["events"][0]["event"], "CPI")


if __name__ == "__main__":
    unittest.main()
