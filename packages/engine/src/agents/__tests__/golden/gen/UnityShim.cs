// The few UnityEngine members the agent sources use, with Unity's reference-source formulas (UnityCsReference
// Runtime/Export/Math/Mathf.cs), so the golden values are what the Unity build computes.
using System;

namespace UnityEngine
{
    public static class Mathf
    {
        public const float Deg2Rad = (float)(Math.PI * 2.0 / 360.0);
        public static float Clamp01(float value) => value < 0f ? 0f : value > 1f ? 1f : value;
        public static float Clamp(float value, float min, float max) => value < min ? min : value > max ? max : value;
        public static int Clamp(int value, int min, int max) => value < min ? min : value > max ? max : value;
        public static float Lerp(float a, float b, float t) => a + (b - a) * Clamp01(t);
        public static float InverseLerp(float a, float b, float value) => a != b ? Clamp01((value - a) / (b - a)) : 0f;
        public static int RoundToInt(float f) => (int)Math.Round(f);
        public static float Round(float f) => (float)Math.Round(f);
        public static float Max(float a, float b) => a > b ? a : b;
        public static int Max(int a, int b) => a > b ? a : b;
        public static float Min(float a, float b) => a < b ? a : b;
        public static int Min(int a, int b) => a < b ? a : b;
        public static float Abs(float f) => Math.Abs(f);
    }

    public static class Time
    {
        /// <summary>Settable for the golden scenarios (Unity's is the real clock).</summary>
        public static float realtimeSinceStartup;
    }

    public static class Debug
    {
        public static void Log(object message) { }
        public static void LogWarning(object message) { }
    }
}
